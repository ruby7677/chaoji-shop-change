-- 現貨宅配付款前已確認運費後的收尾：
-- 1. admin_transition_order：宅配「完成（出貨）」除了已確認尾款，也接受「運費已確認且已收金額 ≥ 應付總額」，
--    現貨宅配確認款項後即可直接出貨，不用再勾「已確認全額與運費入帳」。預購宅配確認時只收訂金，仍須先確認尾款。
-- 2. admin_update_order_fulfillment：付款前已確認運費的現貨宅配，回報匯款或確認款項後不可再改運費（SHIPPING_FEE_LOCKED）。
-- 其餘規則與 202610110001_cvs_delivery.sql、202610120001_home_fee_before_payment.sql 的定義相同。
-- 後台狀態轉換：與 202610030001 相同，另加「交貨便未付清不可完成（出貨）」。
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
    (v_order.status = 'confirmed' and p_target_status in ('partially_ready', 'ready_for_pickup', 'completed', 'cancelled')) or
    (v_order.status = 'partially_ready' and p_target_status in ('ready_for_pickup', 'completed', 'cancelled')) or
    (v_order.status = 'ready_for_pickup' and p_target_status in ('completed', 'cancelled'))
  ) then
    raise exception 'INVALID_ORDER_TRANSITION';
  end if;
  if p_target_status = 'cancelled' and v_note = '' then
    raise exception 'ORDER_NOTE_REQUIRED';
  end if;
  -- 取消已付款／已回報的訂單必須記錄實際退款金額（0 也要明確填寫）；未付款訂單沒有收過錢，固定為 0。
  -- 上限為訂單應付總額加實際運費，避免誤填超額。
  if p_target_status = 'cancelled' then
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
  -- 宅配完成（出貨）須已收齊商品＋運費：預購或付款後才補運費的訂單要先確認尾款；
  -- 現貨宅配在付款前已確認運費（本次應付含運），確認款項時即已付清。
  if p_target_status = 'completed'
     and v_order.delivery_method = 'home_delivery'
     and v_order.final_payment_confirmed_at is null
     and not (v_order.shipping_fee_notified_at is not null and v_order.paid_amount >= v_order.amount_due) then
    raise exception 'FINAL_PAYMENT_REQUIRED';
  end if;
  -- 交貨便完成＝已出貨：現貨確認付款時已付清（含運費）；預購須先確認尾款與運費。
  if p_target_status = 'completed'
     and v_order.delivery_method = 'cvs_delivery'
     and v_order.paid_amount < v_order.amount_due then
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
         refunded_amount = case when p_target_status = 'cancelled' then v_refund else refunded_amount end,
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

  -- 現貨宅配付款前已確認運費（本次應付＝含運總額）後，客人照這個金額匯款；回報或入帳後不可再改運費，
  -- 否則已收金額與應付對不上。付款後才補填運費的訂單（本次應付不含運）仍可在這裡確認尾款。
  if v_order.delivery_method = 'home_delivery'
     and not v_has_preorder
     and v_order.status in ('pending_review', 'confirmed')
     and v_order.shipping_fee_notified_at is not null
     and v_order.deposit_due >= v_order.amount_due then
    raise exception 'SHIPPING_FEE_LOCKED';
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
