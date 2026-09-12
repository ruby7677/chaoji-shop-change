-- 潮吉好頑：到店支付訂單流程。
-- 到店支付以 orders.bank_account_id is null 表示；不新增欄位，保留既有資料相容性。
-- 到店支付僅限到店取貨的現貨商品，庫存保留最長 3 個月；匯款訂單仍為 24 小時。

begin;

create or replace function public.create_delivery_order(
  p_items jsonb,
  p_pickup_plan text default 'together',
  p_delivery_method text default 'store_pickup',
  p_coupon_code text default null,
  p_points_to_redeem integer default 0,
  p_bank_account_id uuid default null,
  p_payment_last_five text default null,
  p_shipping_address text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member_id uuid := auth.uid();
  v_order_id uuid := gen_random_uuid();
  v_order_number text := 'CJ-' || to_char(now(), 'YYMMDD-HH24MISS') || '-' || upper(substr(replace(v_order_id::text, '-', ''), 1, 4));
  v_subtotal integer := 0;
  v_product_deposit integer := 0;
  v_coupon_eligible integer := 0;
  v_coupon_discount integer := 0;
  v_point_discount integer := 0;
  v_product_amount integer := 0;
  v_amount integer := 0;
  v_deposit integer := 0;
  v_shipping_units integer := 0;
  v_shipping_fee integer := 0;
  v_payment_deadline timestamptz;
  v_store_payment boolean := p_bank_account_id is null;
  v_has_preorder boolean := false;
  v_item record;
  v_variant record;
  v_available integer;
  v_coupon public.coupons;
  v_settings public.point_settings;
  v_balance integer;
  v_point_cap integer;
begin
  if v_member_id is null then raise exception 'LOGIN_REQUIRED'; end if;
  if not exists (
    select 1 from public.profiles
    where id = v_member_id
      and nullif(trim(full_name), '') is not null
      and nullif(trim(phone), '') is not null
  ) then raise exception 'PROFILE_INCOMPLETE'; end if;
  if p_pickup_plan not in ('together', 'split') then raise exception 'INVALID_PICKUP_PLAN'; end if;
  if p_delivery_method not in ('store_pickup', 'seller_delivery', 'home_delivery') then raise exception 'INVALID_DELIVERY_METHOD'; end if;
  if p_delivery_method = 'home_delivery' and nullif(trim(coalesce(p_shipping_address, '')), '') is null then raise exception 'SHIPPING_ADDRESS_REQUIRED'; end if;
  if v_store_payment and p_delivery_method <> 'store_pickup' then raise exception 'STORE_PAYMENT_ONLY_STORE_PICKUP'; end if;
  if v_store_payment and p_payment_last_five is not null then raise exception 'INVALID_PAYMENT_METHOD'; end if;
  if not v_store_payment and not exists (select 1 from public.bank_accounts where id = p_bank_account_id and is_active) then raise exception 'BANK_ACCOUNT_REQUIRED'; end if;
  if coalesce(p_points_to_redeem, 0) < 0 then raise exception 'INVALID_POINTS'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'EMPTY_CART'; end if;
  if p_payment_last_five is not null and p_payment_last_five !~ '^[0-9]{5}$' then raise exception 'INVALID_PAYMENT_LAST_FIVE'; end if;

  if nullif(upper(trim(coalesce(p_coupon_code, ''))), '') is not null then
    select * into v_coupon from public.coupons where code = upper(trim(p_coupon_code)) for update;
    if not found then raise exception 'COUPON_NOT_FOUND'; end if;
    if not v_coupon.is_active or now() < v_coupon.valid_from or now() > v_coupon.valid_until then raise exception 'COUPON_EXPIRED'; end if;
    if exists (select 1 from public.coupon_members where coupon_id = v_coupon.id)
       and not exists (select 1 from public.coupon_members where coupon_id = v_coupon.id and member_id = v_member_id) then raise exception 'COUPON_NOT_ELIGIBLE'; end if;
    if v_coupon.total_usage_limit is not null and (select count(*) from public.coupon_redemptions where coupon_id = v_coupon.id) >= v_coupon.total_usage_limit then raise exception 'COUPON_USAGE_LIMIT'; end if;
    if (select count(*) from public.coupon_redemptions where coupon_id = v_coupon.id and member_id = v_member_id) >= v_coupon.per_member_limit then raise exception 'COUPON_MEMBER_LIMIT'; end if;
  end if;

  for v_item in select * from jsonb_to_recordset(p_items) as x(variant_id uuid, quantity integer) loop
    if v_item.quantity is null or v_item.quantity < 1 then raise exception 'INVALID_QUANTITY'; end if;
    select v.*, p.name as product_name, p.id as parent_product_id
      into v_variant
      from public.product_variants v
      join public.products p on p.id = v.product_id
     where v.id = v_item.variant_id and v.is_published and p.is_published
     for update of v;
    if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
    if v_variant.kind = 'preorder' then v_has_preorder := true; end if;

    select v_variant.stock_on_hand - coalesce(sum(r.quantity) filter (where r.released_at is null and r.expires_at > now()), 0)
      into v_available
      from public.inventory_reservations r
     where r.variant_id = v_variant.id;
    if v_available < v_item.quantity then raise exception 'INSUFFICIENT_STOCK'; end if;

    v_subtotal := v_subtotal + v_variant.price * v_item.quantity;
    v_product_deposit := v_product_deposit + case
      when v_variant.kind = 'in_stock' and v_variant.deposit_rate = 0 then v_variant.price * v_item.quantity
      else round(v_variant.price * v_item.quantity * v_variant.deposit_rate)
    end;
    v_shipping_units := v_shipping_units + v_variant.shipping_units * v_item.quantity;
    if v_coupon.id is not null and (
      not exists (select 1 from public.coupon_products where coupon_id = v_coupon.id)
      or exists (select 1 from public.coupon_products where coupon_id = v_coupon.id and product_id = v_variant.parent_product_id)
    ) then
      v_coupon_eligible := v_coupon_eligible + v_variant.price * v_item.quantity;
    end if;
  end loop;

  if v_store_payment and v_has_preorder then raise exception 'STORE_PAYMENT_PREORDER_NOT_ALLOWED'; end if;

  if v_coupon.id is not null then
    if v_coupon_eligible = 0 then raise exception 'COUPON_PRODUCT_NOT_ELIGIBLE'; end if;
    v_coupon_discount := least(v_coupon.discount_amount, v_coupon_eligible);
  end if;

  if coalesce(p_points_to_redeem, 0) > 0 then
    if v_coupon.id is not null and not v_coupon.combinable_with_points then raise exception 'COUPON_POINTS_NOT_COMBINABLE'; end if;
    select * into v_settings from public.point_settings where id = true;
    if p_points_to_redeem < v_settings.min_redeem_points then raise exception 'POINT_MINIMUM'; end if;
    perform pg_advisory_xact_lock(hashtext(v_member_id::text));
    select coalesce(sum(points), 0) into v_balance from public.point_ledger where member_id = v_member_id;
    if p_points_to_redeem > v_balance then raise exception 'INSUFFICIENT_POINTS'; end if;
    v_point_discount := p_points_to_redeem * v_settings.point_value;
    v_point_cap := case when v_settings.max_redeem_mode = 'percent'
      then floor((v_subtotal - v_coupon_discount) * v_settings.max_redeem_value / 100.0)::integer
      else v_settings.max_redeem_value end;
    v_point_cap := least(v_point_cap, v_subtotal - v_coupon_discount);
    if v_point_discount > v_point_cap then raise exception 'POINT_LIMIT_EXCEEDED'; end if;
  end if;

  v_product_amount := greatest(v_subtotal - v_coupon_discount - v_point_discount, 0);
  v_shipping_fee := public.calculate_shipping_fee(p_delivery_method, v_shipping_units);
  v_amount := v_product_amount + v_shipping_fee;
  v_deposit := case
    when v_store_payment then 0
    else least(greatest(v_product_deposit - v_coupon_discount - v_point_discount, 0), v_product_amount) + v_shipping_fee
  end;
  v_payment_deadline := now() + case when v_store_payment then interval '3 months' else interval '24 hours' end;

  perform set_config('app.verified_discount', 'on', true);
  insert into public.orders(
    id, order_number, member_id, status, pickup_plan, delivery_method, shipping_fee, shipping_address,
    subtotal, coupon_discount, point_discount, amount_due, deposit_due, payment_deadline,
    bank_account_id, payment_last_five, coupon_id, points_redeemed
  )
  values (
    v_order_id, v_order_number, v_member_id,
    case when v_store_payment then 'pending_payment'::public.order_status
      when p_payment_last_five is null then 'pending_payment'::public.order_status
      else 'pending_review'::public.order_status end,
    p_pickup_plan, p_delivery_method, v_shipping_fee,
    case when p_delivery_method = 'home_delivery' then trim(p_shipping_address) else null end,
    v_subtotal, v_coupon_discount, v_point_discount, v_amount, v_deposit, v_payment_deadline,
    p_bank_account_id, case when v_store_payment then null else p_payment_last_five end, v_coupon.id, coalesce(p_points_to_redeem, 0)
  );

  for v_item in select * from jsonb_to_recordset(p_items) as x(variant_id uuid, quantity integer) loop
    select v.*, p.name as product_name
      into v_variant
      from public.product_variants v
      join public.products p on p.id = v.product_id
     where v.id = v_item.variant_id;
    insert into public.order_items(order_id, variant_id, product_name, variant_name, unit_price, quantity, kind, deposit_rate, arrival_snapshot)
    values (v_order_id, v_variant.id, v_variant.product_name, v_variant.name, v_variant.price, v_item.quantity, v_variant.kind, v_variant.deposit_rate, v_variant.preorder_arrival);
    insert into public.inventory_reservations(variant_id, order_id, quantity, expires_at)
    values (v_variant.id, v_order_id, v_item.quantity, v_payment_deadline);
  end loop;

  if v_coupon.id is not null then
    insert into public.coupon_redemptions(coupon_id, member_id, order_id, discount_amount)
    values (v_coupon.id, v_member_id, v_order_id, v_coupon_discount);
  end if;
  if coalesce(p_points_to_redeem, 0) > 0 then
    insert into public.point_ledger(member_id, order_id, kind, points, reason)
    values (v_member_id, v_order_id, 'redeem', -p_points_to_redeem, '訂單 ' || v_order_number || ' 點數折抵');
  end if;
  return v_order_id;
end;
$$;

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

revoke all on function public.create_delivery_order(jsonb, text, text, text, integer, uuid, text, text) from public, anon;
grant execute on function public.create_delivery_order(jsonb, text, text, text, integer, uuid, text, text) to authenticated;
revoke all on function public.admin_transition_order(uuid, uuid, public.order_status, text) from public, anon, authenticated;
grant execute on function public.admin_transition_order(uuid, uuid, public.order_status, text) to service_role;

commit;
