-- 潮吉好頑：到貨後人工設定實際運費與尾款確認。
-- 下單時不估算賣貨便／宅配運費；到貨後由管理員填入實際運費，
-- 客戶匯入尾款與運費後，管理員記錄末五碼並確認，才可完成寄送訂單。

begin;

alter table public.orders
  add column if not exists shipping_fee_notified_at timestamptz,
  add column if not exists final_payment_last_five text
    check (final_payment_last_five is null or final_payment_last_five ~ '^[0-9]{5}$'),
  add column if not exists final_payment_confirmed_at timestamptz;

comment on column public.orders.shipping_fee is
  '實際寄送運費；新訂單建立時為 0，到貨後由管理員人工填寫';
comment on column public.orders.final_payment_last_five is
  '尾款與運費匯款帳號末五碼，僅供管理員核對';

create or replace function public.admin_update_order_fulfillment(
  p_actor_id uuid,
  p_order_id uuid,
  p_shipping_fee integer,
  p_final_payment_confirmed boolean default false,
  p_final_payment_last_five text default null,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_base_amount integer;
  v_new_amount integer;
  v_note text := coalesce(trim(p_note), '');
  v_confirmed boolean := coalesce(p_final_payment_confirmed, false);
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then
    raise exception 'ADMIN_REQUIRED';
  end if;
  if p_shipping_fee is null or p_shipping_fee < 0 then
    raise exception 'INVALID_SHIPPING_FEE';
  end if;
  if p_final_payment_last_five is not null and p_final_payment_last_five !~ '^[0-9]{5}$' then
    raise exception 'INVALID_FINAL_PAYMENT_LAST_FIVE';
  end if;

  select * into v_order
    from public.orders
   where id = p_order_id
   for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.status in ('cancelled', 'refunded', 'completed') then
    raise exception 'ORDER_FULFILLMENT_NOT_EDITABLE';
  end if;
  if v_order.delivery_method = 'store_pickup' and p_shipping_fee <> 0 then
    raise exception 'SHIPPING_FEE_STORE_PICKUP';
  end if;
  if v_confirmed then
    if v_order.delivery_method = 'store_pickup' then
      raise exception 'SHIPPING_FEE_STORE_PICKUP';
    end if;
    if v_order.status not in ('partially_ready', 'ready_for_pickup') then
      raise exception 'FINAL_PAYMENT_NOT_ALLOWED';
    end if;
    if p_final_payment_last_five is null then
      raise exception 'FINAL_PAYMENT_REQUIRED';
    end if;
  end if;

  v_base_amount := v_order.amount_due - coalesce(v_order.shipping_fee, 0);
  v_new_amount := v_base_amount + p_shipping_fee;
  if v_new_amount < v_order.paid_amount then
    raise exception 'INVALID_SHIPPING_FEE';
  end if;

  update public.orders
     set shipping_fee = p_shipping_fee,
         amount_due = v_new_amount,
         shipping_fee_notified_at = case
           when p_shipping_fee > 0 then coalesce(shipping_fee_notified_at, now())
           else shipping_fee_notified_at
         end,
         final_payment_last_five = case when v_confirmed then p_final_payment_last_five else null end,
         final_payment_confirmed_at = case when v_confirmed then now() else null end,
         paid_amount = case when v_confirmed then v_new_amount else least(paid_amount, deposit_due) end,
         admin_note = case when v_note = '' then admin_note else v_note end,
         updated_at = now()
   where id = p_order_id;

  return jsonb_build_object(
    'id', p_order_id,
    'shipping_fee', p_shipping_fee,
    'amount_due', v_new_amount,
    'paid_amount', case when v_confirmed then v_new_amount else least(v_order.paid_amount, v_order.deposit_due) end,
    'final_payment_confirmed', v_confirmed
  );
end;
$$;

-- 完成寄送／訂單前，非到店取貨訂單必須先由管理員確認尾款與實際運費。
create or replace function public.admin_transition_order(
  p_actor_id uuid,
  p_order_id uuid,
  p_target_status public.order_status,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_item record;
  v_stock integer;
  v_note text := coalesce(trim(p_note), '');
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.status = p_target_status then raise exception 'ORDER_STATUS_UNCHANGED'; end if;

  if not (
    (v_order.status = 'pending_payment' and p_target_status = 'cancelled') or
    (v_order.status = 'pending_payment' and v_order.bank_account_id is null and p_target_status = 'confirmed') or
    (v_order.status = 'pending_review' and p_target_status in ('confirmed', 'cancelled')) or
    (v_order.status = 'confirmed' and p_target_status in ('partially_ready', 'ready_for_pickup', 'completed', 'cancelled', 'refund_pending')) or
    (v_order.status = 'partially_ready' and p_target_status in ('ready_for_pickup', 'completed', 'cancelled', 'refund_pending')) or
    (v_order.status = 'ready_for_pickup' and p_target_status in ('completed', 'cancelled', 'refund_pending')) or
    (v_order.status = 'completed' and p_target_status = 'refund_pending') or
    (v_order.status = 'refund_pending' and p_target_status in ('refunded', 'completed'))
  ) then raise exception 'INVALID_ORDER_TRANSITION'; end if;
  if p_target_status in ('cancelled', 'refund_pending', 'refunded') and v_note = '' then raise exception 'ORDER_NOTE_REQUIRED'; end if;
  if p_target_status = 'partially_ready' and v_order.pickup_plan <> 'split' then raise exception 'PARTIAL_READY_REQUIRES_SPLIT'; end if;
  if p_target_status = 'completed'
     and v_order.delivery_method <> 'store_pickup'
     and v_order.final_payment_confirmed_at is null then
    raise exception 'FINAL_PAYMENT_REQUIRED';
  end if;

  if p_target_status = 'confirmed' and (v_order.status = 'pending_review' or (v_order.status = 'pending_payment' and v_order.bank_account_id is null)) then
    if v_order.status = 'pending_review' and v_order.payment_last_five is null then raise exception 'PAYMENT_REPORT_REQUIRED'; end if;
    for v_item in select oi.variant_id, oi.quantity from public.order_items oi where oi.order_id = p_order_id order by oi.variant_id loop
      select stock_on_hand into v_stock from public.product_variants where id = v_item.variant_id for update;
      if not found or v_stock < v_item.quantity then raise exception 'INSUFFICIENT_STOCK'; end if;
      update public.product_variants set stock_on_hand = stock_on_hand - v_item.quantity, updated_at = now() where id = v_item.variant_id;
      insert into public.inventory_movements(variant_id, order_id, kind, quantity_delta, reason, actor_id)
      values (v_item.variant_id, p_order_id, 'sale', -v_item.quantity,
        case when v_order.bank_account_id is null then '確認到店支付訂單 ' || v_order.order_number else '確認訂單 ' || v_order.order_number || ' 付款' end,
        p_actor_id);
    end loop;
  end if;

  update public.orders
     set status = p_target_status,
         admin_note = case when v_note = '' then admin_note else v_note end,
         paid_amount = case when p_target_status = 'confirmed' then deposit_due when p_target_status = 'completed' then amount_due else paid_amount end,
         payment_confirmed_at = case when p_target_status = 'confirmed' then now() else payment_confirmed_at end,
         completed_at = case when p_target_status = 'completed' then now() else completed_at end,
         cancelled_at = case when p_target_status = 'cancelled' then now() else cancelled_at end,
         updated_at = now()
   where id = p_order_id;
  insert into public.order_status_history(order_id, from_status, to_status, note, actor_id)
  values (p_order_id, v_order.status, p_target_status, v_note, p_actor_id);
  return jsonb_build_object('id', p_order_id, 'status', p_target_status, 'paid_amount', case when p_target_status = 'confirmed' then v_order.deposit_due when p_target_status = 'completed' then v_order.amount_due else v_order.paid_amount end);
end;
$$;

revoke all on function public.admin_update_order_fulfillment(uuid, uuid, integer, boolean, text, text) from public, anon, authenticated;
grant execute on function public.admin_update_order_fulfillment(uuid, uuid, integer, boolean, text, text) to service_role;
revoke all on function public.admin_transition_order(uuid, uuid, public.order_status, text) from public, anon, authenticated;
grant execute on function public.admin_transition_order(uuid, uuid, public.order_status, text) to service_role;

commit;
