-- 取消訂單與確認已退款時記錄退款金額（業主 2026-10-02 決定），並在會員通知顯示「已取消訂單，並已退款 NT$X」。
-- 1. orders.refunded_amount：取消或確認已退款時寫入；未付款取消固定為 0；其他狀態維持原值（null 代表沒有退款紀錄）。
-- 2. admin_transition_order 新增 p_refund_amount（預設 null，舊的 4 參數呼叫仍可對應）：
--    取消（已付款或已回報）與確認已退款必填，0 ≤ 金額 ≤ 應付總額 + 實際運費；其他狀態不可帶金額。
--    狀態歷程備註附上「（退款 NT$X）」。
-- 舊的 4 參數版本先移除，避免同名 overload 造成呼叫歧義。

begin;

alter table public.orders
  add column if not exists refunded_amount integer check (refunded_amount is null or refunded_amount >= 0);

drop function if exists public.admin_transition_order(uuid, uuid, public.order_status, text);

create or replace function public.admin_transition_order(
  p_actor_id uuid,
  p_order_id uuid,
  p_target_status public.order_status,
  p_note text default null,
  p_refund_amount integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public.orders%rowtype;
  v_item record;
  v_sale public.inventory_movements%rowtype;
  v_stock integer;
  v_note text := coalesce(trim(p_note), '');
  v_refund integer;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then
    raise exception 'ADMIN_REQUIRED';
  end if;
  select * into v_order
    from public.orders
   where id = p_order_id
   for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.status = p_target_status then raise exception 'ORDER_STATUS_UNCHANGED'; end if;

  -- ready_for_pickup is the shipped state for in-stock seller-delivery orders.
  -- The database cannot prove whether an external 7-11 parcel was handed over,
  -- so use the conservative refund/return flow instead of auto-restocking it.
  if p_target_status = 'cancelled'
     and v_order.delivery_method = 'seller_delivery'
     and v_order.status = 'ready_for_pickup' then
    raise exception 'SELLER_DELIVERY_SHIPPED_REQUIRES_REFUND';
  end if;

  if not (
    (v_order.status = 'pending_payment' and p_target_status = 'cancelled') or
    (v_order.status = 'pending_payment' and v_order.bank_account_id is null and p_target_status = 'confirmed') or
    (v_order.status = 'pending_review' and p_target_status in ('confirmed', 'cancelled')) or
    (v_order.status = 'confirmed' and p_target_status in ('partially_ready', 'ready_for_pickup', 'completed', 'cancelled', 'refund_pending')) or
    (v_order.status = 'partially_ready' and p_target_status in ('ready_for_pickup', 'completed', 'cancelled', 'refund_pending')) or
    (v_order.status = 'ready_for_pickup' and p_target_status in ('completed', 'cancelled', 'refund_pending')) or
    (v_order.status = 'completed' and p_target_status = 'refund_pending') or
    (v_order.status = 'refund_pending' and p_target_status in ('refunded', 'completed'))
  ) then
    raise exception 'INVALID_ORDER_TRANSITION';
  end if;
  if p_target_status in ('cancelled', 'refund_pending', 'refunded') and v_note = '' then
    raise exception 'ORDER_NOTE_REQUIRED';
  end if;
  -- 取消與確認已退款必須記錄實際退款金額（0 也要明確填寫）；未付款訂單沒有收過錢，固定為 0。
  -- 上限為訂單應付總額加實際運費，避免誤填超額。
  if p_target_status in ('cancelled', 'refunded') then
    if v_order.status = 'pending_payment' then
      if coalesce(p_refund_amount, 0) <> 0 then raise exception 'REFUND_NOT_ALLOWED_UNPAID'; end if;
      v_refund := 0;
    else
      if p_refund_amount is null then raise exception 'REFUND_AMOUNT_REQUIRED'; end if;
      if p_refund_amount < 0 or p_refund_amount > v_order.amount_due + coalesce(v_order.shipping_fee, 0) then
        raise exception 'INVALID_REFUND_AMOUNT';
      end if;
      v_refund := p_refund_amount;
      v_note := v_note || '（退款 NT$' || v_refund::text || '）';
    end if;
  elsif p_refund_amount is not null then
    raise exception 'REFUND_AMOUNT_NOT_APPLICABLE';
  end if;
  if p_target_status = 'partially_ready' and v_order.pickup_plan <> 'split' then
    raise exception 'PARTIAL_READY_REQUIRES_SPLIT';
  end if;
  if p_target_status = 'completed'
     and v_order.delivery_method = 'home_delivery'
     and v_order.final_payment_confirmed_at is null then
    raise exception 'FINAL_PAYMENT_REQUIRED';
  end if;

  if p_target_status = 'confirmed'
     and (v_order.status = 'pending_review' or (v_order.status = 'pending_payment' and v_order.bank_account_id is null)) then
    if v_order.status = 'pending_review' and v_order.payment_last_five is null then
      raise exception 'PAYMENT_REPORT_REQUIRED';
    end if;
    for v_item in
      select oi.variant_id, oi.quantity
        from public.order_items oi
       where oi.order_id = p_order_id
       order by oi.variant_id
    loop
      select stock_on_hand into v_stock
        from public.product_variants
       where id = v_item.variant_id
       for update;
      if not found or v_stock < v_item.quantity then raise exception 'INSUFFICIENT_STOCK'; end if;
      update public.product_variants
         set stock_on_hand = stock_on_hand - v_item.quantity,
             updated_at = now()
       where id = v_item.variant_id;
      insert into public.inventory_movements(variant_id, order_id, kind, quantity_delta, reason, actor_id)
      values (
        v_item.variant_id,
        p_order_id,
        'sale',
        -v_item.quantity,
        case when v_order.bank_account_id is null
          then '確認到店支付訂單 ' || v_order.order_number
          else '確認訂單 ' || v_order.order_number || ' 付款'
        end,
        p_actor_id
      );
    end loop;
  end if;

  if p_target_status = 'cancelled' then
    -- pending_payment / pending_review 尚未產生 sale；此迴圈為空，只由 reservation trigger 釋放保留。
    -- confirmed 之後已有 sale 的訂單仍未 completed，取消時才逐筆反轉實體庫存。
    for v_sale in
      select im.*
        from public.inventory_movements im
       where im.order_id = p_order_id
         and im.kind = 'sale'
       order by im.variant_id, im.id
       for update
    loop
      if not exists (
        select 1
          from public.inventory_movements reversal
         where reversal.source_movement_id = v_sale.id
           and reversal.kind = 'refund'
      ) then
        update public.product_variants
           set stock_on_hand = stock_on_hand + abs(v_sale.quantity_delta),
               updated_at = now()
         where id = v_sale.variant_id;
        insert into public.inventory_movements(
          variant_id, order_id, kind, quantity_delta, reason, actor_id, source_movement_id
        )
        values (
          v_sale.variant_id,
          p_order_id,
          'refund',
          abs(v_sale.quantity_delta),
          '取消訂單 ' || v_order.order_number || ' 回補未交付庫存',
          p_actor_id,
          v_sale.id
        );
      end if;
    end loop;
  end if;

  update public.orders
     set status = p_target_status,
         admin_note = case when v_note = '' then admin_note else v_note end,
         paid_amount = case
           when p_target_status = 'confirmed' then case when v_order.final_payment_confirmed_at is not null then amount_due else deposit_due end
           when p_target_status = 'completed' then amount_due
           else paid_amount
         end,
         payment_confirmed_at = case when p_target_status = 'confirmed' then now() else payment_confirmed_at end,
         completed_at = case when p_target_status = 'completed' then now() else completed_at end,
         cancelled_at = case when p_target_status = 'cancelled' then now() else cancelled_at end,
         refunded_amount = case when p_target_status in ('cancelled', 'refunded') then v_refund else refunded_amount end,
         updated_at = now()
   where id = p_order_id;

  insert into public.order_status_history(order_id, from_status, to_status, note, actor_id)
  values (p_order_id, v_order.status, p_target_status, v_note, p_actor_id);

  return jsonb_build_object(
    'id', p_order_id,
    'status', p_target_status,
    'refunded_amount', v_refund,
    'paid_amount', case
      when p_target_status = 'confirmed' then
        case when v_order.final_payment_confirmed_at is not null then v_order.amount_due else v_order.deposit_due end
      when p_target_status = 'completed' then v_order.amount_due
      else v_order.paid_amount
    end
  );
end;
$function$;

revoke all on function public.admin_transition_order(uuid,uuid,public.order_status,text,integer) from public, anon, authenticated;
grant execute on function public.admin_transition_order(uuid,uuid,public.order_status,text,integer) to service_role;

commit;
