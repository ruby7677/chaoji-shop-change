-- 現貨宅配改為「小幫手確認運費後才匯款」：
-- 1. 待付款（pending_payment）的現貨宅配可儲存運費：本次應付（deposit_due）改為含運總額，
--    付款期限與庫存保留從儲存當下重給 24 小時（只延長、不縮短）；已逾期的訂單不可再延長。
-- 2. 宅配儲存運費（含 0 元免運）都記錄 shipping_fee_notified_at，前台以它判斷運費已確認、可顯示匯款帳號。
-- 其餘規則與 202610110001_cvs_delivery.sql 的定義相同。
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
set search_path = ''
as $function$
declare
  v_order public.orders%rowtype;
  v_base_amount integer;
  v_new_amount integer;
  v_note text := coalesce(trim(p_note), '');
  v_confirmed boolean := coalesce(p_final_payment_confirmed, false);
  v_has_preorder boolean;
  v_stock_home_unpaid boolean;
  v_new_deadline timestamptz;
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
  if v_order.delivery_method = 'cvs_delivery' and p_shipping_fee <> coalesce(v_order.shipping_fee, 0) then
    raise exception 'CVS_SHIPPING_FEE_FIXED';
  end if;

  v_has_preorder := exists (
    select 1
      from public.order_items oi
     where oi.order_id = v_order.id
       and oi.kind = 'preorder'
  );
  v_stock_home_unpaid := v_order.status = 'pending_payment'
    and v_order.delivery_method = 'home_delivery'
    and not v_has_preorder;

  if v_confirmed then
    if v_order.delivery_method = 'store_pickup' then
      raise exception 'SHIPPING_FEE_STORE_PICKUP';
    end if;
    if v_order.status not in ('partially_ready', 'ready_for_pickup')
       and not (
         v_order.status in ('confirmed', 'pending_review')
         and v_order.delivery_method = 'home_delivery'
         and not v_has_preorder
       ) then
      raise exception 'FINAL_PAYMENT_NOT_ALLOWED';
    end if;
    if p_final_payment_last_five is null then
      raise exception 'FINAL_PAYMENT_REQUIRED';
    end if;
  end if;

  -- 已逾期但尚未被排程取消的訂單，保留量已失效（可能已被其他訂單買走），不可重新延長期限
  if v_stock_home_unpaid and v_order.payment_deadline <= now() then
    raise exception 'PAYMENT_DEADLINE_PASSED';
  end if;

  v_base_amount := v_order.amount_due - coalesce(v_order.shipping_fee, 0);
  v_new_amount := v_base_amount + p_shipping_fee;
  if v_new_amount < v_order.paid_amount then
    raise exception 'INVALID_SHIPPING_FEE';
  end if;
  v_new_deadline := case
    when v_stock_home_unpaid then greatest(v_order.payment_deadline, now() + interval '24 hours')
    else v_order.payment_deadline
  end;

  update public.orders
     set shipping_fee = p_shipping_fee,
         amount_due = v_new_amount,
         deposit_due = case when v_stock_home_unpaid then v_new_amount else deposit_due end,
         payment_deadline = v_new_deadline,
         shipping_fee_notified_at = case
           when delivery_method = 'home_delivery' or p_shipping_fee > 0 then coalesce(shipping_fee_notified_at, now())
           else shipping_fee_notified_at
         end,
         final_payment_last_five = case when v_confirmed then p_final_payment_last_five else null end,
         final_payment_confirmed_at = case when v_confirmed then now() else null end,
         paid_amount = case when v_confirmed then v_new_amount else least(paid_amount, deposit_due) end,
         admin_note = case when v_note = '' then admin_note else v_note end,
         updated_at = now()
   where id = p_order_id;

  -- 庫存保留與付款期限同步延長，避免期限內保留先失效
  if v_stock_home_unpaid then
    update public.inventory_reservations
       set expires_at = greatest(expires_at, v_new_deadline)
     where order_id = p_order_id
       and released_at is null;
  end if;

  return jsonb_build_object(
    'id', p_order_id,
    'shipping_fee', p_shipping_fee,
    'amount_due', v_new_amount,
    'deposit_due', case when v_stock_home_unpaid then v_new_amount else v_order.deposit_due end,
    'payment_deadline', v_new_deadline,
    'paid_amount', case when v_confirmed then v_new_amount else least(v_order.paid_amount, v_order.deposit_due) end,
    'final_payment_confirmed', v_confirmed
  );
end;
$function$;
