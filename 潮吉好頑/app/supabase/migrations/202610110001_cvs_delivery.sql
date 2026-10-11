-- 潮吉好頑：7-11 店到店（交貨便）取代賣貨便（業主決策 2026-10-11）。
-- 1. 新配送方式 cvs_delivery：取件人、手機與取件門市（縣市、鄉鎮區、門市名稱、6 碼店號）必填；
--    運費由資料庫計算：商品小計（折抵前）未滿 6,000 元收 60 元，滿 6,000 元免運。
--    現貨建單時應付含運費；預購訂金不含運費，運費與尾款到貨後一起收。
-- 2. 新訂單不再建立 seller_delivery（SELLER_DELIVERY_RETIRED）；舊訂單資料與後台流程保留。
--    賣貨便是唯一的外部付款方式，停用後所有新訂單一律匯款，付款期限只剩預購 2 小時、現貨 24 小時。
-- 3. 交貨便完成（＝已出貨）前必須付清；預購尾款確認時運費固定，不可在後台改金額。
-- 4. 後台可記錄寄件編號（admin_set_order_shipment_tracking），只顯示在後台與我的訂單。
-- create_delivery_order 新增 14 參數版（含取件門市）；10 參數版保留給舊 Worker 呼叫，改為轉呼叫 14 參數版。

begin;

alter table public.orders
  add column if not exists pickup_store_city text,
  add column if not exists pickup_store_district text,
  add column if not exists pickup_store_name text,
  add column if not exists pickup_store_code text,
  add column if not exists shipment_tracking_number text;

alter table public.orders drop constraint if exists orders_delivery_method_check;
alter table public.orders add constraint orders_delivery_method_check
  check (delivery_method in ('store_pickup', 'seller_delivery', 'home_delivery', 'cvs_delivery'));
alter table public.orders drop constraint if exists orders_pickup_store_check;
alter table public.orders add constraint orders_pickup_store_check check (
  (pickup_store_code is null or pickup_store_code ~ '^[0-9]{6}$')
  and (pickup_store_city is null or char_length(pickup_store_city) <= 10)
  and (pickup_store_district is null or char_length(pickup_store_district) <= 10)
  and (pickup_store_name is null or char_length(pickup_store_name) <= 40)
);
alter table public.orders drop constraint if exists orders_shipment_tracking_number_check;
alter table public.orders add constraint orders_shipment_tracking_number_check
  check (shipment_tracking_number is null or shipment_tracking_number ~ '^[A-Za-z0-9-]{1,40}$');

comment on column public.orders.pickup_store_code is '7-11 店到店（交貨便）取件門市 6 碼店號';
comment on column public.orders.shipment_tracking_number is '7-11 交貨便寄件編號，管理員出貨時填寫';

-- 交貨便運費唯一定義；前端 public/cvs-delivery.js 的常數需與此一致（tests/frontend 檢查）。
create or replace function private.cvs_shipping_fee(p_subtotal integer)
returns integer
language sql
immutable
set search_path = ''
as $function$
  select case when coalesce(p_subtotal, 0) >= 6000 then 0 else 60 end
$function$;

revoke all on function private.cvs_shipping_fee(integer) from public, anon, authenticated;

-- 下單核心（只由 create_delivery_order 包裝函式呼叫，API 角色不可直接執行）。
create or replace function public.create_delivery_order(
  p_items jsonb,
  p_pickup_plan text default 'together',
  p_delivery_method text default 'store_pickup',
  p_coupon_code text default null,
  p_points_to_redeem integer default 0,
  p_bank_account_id uuid default null,
  p_payment_last_five text default null,
  p_shipping_address text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
set timezone to 'Asia/Taipei'
as $function$
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
  v_has_preorder boolean := false;
  v_has_in_stock boolean := false;
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
  if p_pickup_plan <> 'together' then raise exception 'INVALID_PICKUP_PLAN'; end if;
  if p_delivery_method = 'seller_delivery' then raise exception 'SELLER_DELIVERY_RETIRED'; end if;
  if p_delivery_method not in ('store_pickup', 'home_delivery', 'cvs_delivery') then raise exception 'INVALID_DELIVERY_METHOD'; end if;
  if p_delivery_method = 'home_delivery' and nullif(trim(coalesce(p_shipping_address, '')), '') is null then raise exception 'SHIPPING_ADDRESS_REQUIRED'; end if;
  if p_bank_account_id is null then raise exception 'STORE_PAYMENT_BANK_TRANSFER_ONLY'; end if;
  if not exists (select 1 from public.bank_accounts where id = p_bank_account_id and is_active) then raise exception 'BANK_ACCOUNT_REQUIRED'; end if;
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
    if v_variant.kind = 'preorder' then v_has_preorder := true; else v_has_in_stock := true; end if;

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

  if v_has_preorder and v_has_in_stock then raise exception 'MIXED_ORDER_NOT_ALLOWED'; end if;

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
  -- 交貨便免運門檻看折抵前的商品小計；其他配送方式沿用 calculate_shipping_fee（目前固定 0）。
  v_shipping_fee := case
    when p_delivery_method = 'cvs_delivery' then private.cvs_shipping_fee(v_subtotal)
    else public.calculate_shipping_fee(p_delivery_method, v_shipping_units)
  end;
  v_amount := v_product_amount + v_shipping_fee;
  -- 預購訂金只算商品；運費與尾款到貨後一起收。現貨建單即付清商品與運費。
  -- 現貨交貨便一律全額（不看規格的訂金比例）：出貨即完成，後台沒有另收尾款的步驟。
  v_deposit := case
    when p_delivery_method = 'cvs_delivery' and not v_has_preorder then v_amount
    else least(greatest(v_product_deposit - v_coupon_discount - v_point_discount, 0), v_product_amount)
      + case when v_has_preorder then 0 else v_shipping_fee end
  end;
  v_payment_deadline := now() + case when v_has_preorder then interval '2 hours' else interval '24 hours' end;

  perform set_config('app.verified_discount', 'on', true);
  insert into public.orders(
    id, order_number, member_id, status, pickup_plan, delivery_method, shipping_fee, shipping_address,
    subtotal, coupon_discount, point_discount, amount_due, deposit_due, payment_deadline,
    bank_account_id, payment_last_five, coupon_id, points_redeemed
  )
  values (
    v_order_id, v_order_number, v_member_id,
    case when p_payment_last_five is null then 'pending_payment'::public.order_status else 'pending_review'::public.order_status end,
    p_pickup_plan, p_delivery_method, v_shipping_fee,
    case when p_delivery_method = 'home_delivery' then trim(p_shipping_address) else null end,
    v_subtotal, v_coupon_discount, v_point_discount, v_amount, v_deposit, v_payment_deadline,
    p_bank_account_id, p_payment_last_five, v_coupon.id, coalesce(p_points_to_redeem, 0)
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
$function$;

-- 會員建單入口（14 參數）：驗證收件人與取件門市後呼叫下單核心，再寫入收件與門市欄位。
create or replace function public.create_delivery_order(
  p_items jsonb,
  p_pickup_plan text,
  p_delivery_method text,
  p_coupon_code text,
  p_points_to_redeem integer,
  p_bank_account_id uuid,
  p_payment_last_five text,
  p_shipping_address text,
  p_shipping_recipient_name text,
  p_shipping_phone text,
  p_pickup_store_city text,
  p_pickup_store_district text,
  p_pickup_store_name text,
  p_pickup_store_code text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order_id uuid;
  v_needs_recipient boolean := p_delivery_method in ('home_delivery', 'cvs_delivery');
  v_cvs boolean := p_delivery_method = 'cvs_delivery';
  v_name text := nullif(trim(coalesce(p_shipping_recipient_name, '')), '');
  v_phone text := regexp_replace(trim(coalesce(p_shipping_phone, '')), '[\s-]+', '', 'g');
  v_city text := nullif(trim(coalesce(p_pickup_store_city, '')), '');
  v_district text := nullif(trim(coalesce(p_pickup_store_district, '')), '');
  v_store text := nullif(trim(coalesce(p_pickup_store_name, '')), '');
  v_code text := regexp_replace(coalesce(p_pickup_store_code, ''), '\s+', '', 'g');
begin
  if p_delivery_method = 'home_delivery' and nullif(trim(coalesce(p_shipping_address, '')), '') is null then
    raise exception 'SHIPPING_ADDRESS_REQUIRED';
  end if;
  if v_needs_recipient then
    if v_name is null then raise exception 'SHIPPING_RECIPIENT_REQUIRED'; end if;
    if v_phone !~ '^09[0-9]{8}$' then raise exception 'SHIPPING_PHONE_REQUIRED'; end if;
  end if;
  if v_cvs then
    if v_city is null or v_district is null or v_store is null then raise exception 'CVS_PICKUP_STORE_REQUIRED'; end if;
    if char_length(v_city) > 10 or char_length(v_district) > 10 or char_length(v_store) > 40 then raise exception 'CVS_PICKUP_STORE_INVALID'; end if;
    if v_code !~ '^[0-9]{6}$' then raise exception 'CVS_PICKUP_STORE_CODE_INVALID'; end if;
  end if;

  v_order_id := public.create_delivery_order(
    p_items, p_pickup_plan, p_delivery_method, p_coupon_code, p_points_to_redeem,
    p_bank_account_id, p_payment_last_five, p_shipping_address
  );

  update public.orders
     set shipping_recipient_name = case when v_needs_recipient then v_name else null end,
         shipping_phone = case when v_needs_recipient then v_phone else null end,
         pickup_store_city = case when v_cvs then v_city else null end,
         pickup_store_district = case when v_cvs then v_district else null end,
         pickup_store_name = case when v_cvs then v_store else null end,
         pickup_store_code = case when v_cvs then v_code else null end,
         updated_at = now()
   where id = v_order_id
     and member_id = auth.uid();
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  return v_order_id;
end;
$function$;

revoke all on function public.create_delivery_order(jsonb, text, text, text, integer, uuid, text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.create_delivery_order(jsonb, text, text, text, integer, uuid, text, text, text, text, text, text, text, text) to authenticated;

-- 舊 10 參數入口：部署期間舊 Worker 仍會呼叫；沒有門市欄位，交貨便會被 14 參數版拒絕。
create or replace function public.create_delivery_order(
  p_items jsonb,
  p_pickup_plan text,
  p_delivery_method text,
  p_coupon_code text,
  p_points_to_redeem integer,
  p_bank_account_id uuid,
  p_payment_last_five text,
  p_shipping_address text,
  p_shipping_recipient_name text,
  p_shipping_phone text
)
returns uuid
language sql
security definer
set search_path = ''
as $function$
  select public.create_delivery_order(
    p_items, p_pickup_plan, p_delivery_method, p_coupon_code, p_points_to_redeem,
    p_bank_account_id, p_payment_last_five, p_shipping_address, p_shipping_recipient_name, p_shipping_phone,
    null::text, null::text, null::text, null::text
  )
$function$;

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
  if p_target_status = 'completed'
     and v_order.delivery_method = 'home_delivery'
     and v_order.final_payment_confirmed_at is null then
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

-- 後台尾款／運費：與既有定義相同，另加「交貨便運費固定，不可改金額」。
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
  if v_confirmed then
    if v_order.delivery_method = 'store_pickup' then
      raise exception 'SHIPPING_FEE_STORE_PICKUP';
    end if;
    if v_order.status not in ('partially_ready', 'ready_for_pickup')
       and not (
         v_order.status in ('confirmed', 'pending_review')
         and v_order.delivery_method = 'home_delivery'
         and not exists (
           select 1
           from public.order_items oi
           where oi.order_id = v_order.id
             and oi.kind = 'preorder'
         )
       ) then
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
$function$;

-- 寄件編號：只限交貨便、未取消的訂單；傳 null 或空字串清除。
create or replace function public.admin_set_order_shipment_tracking(
  p_actor_id uuid,
  p_order_id uuid,
  p_tracking_number text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public.orders%rowtype;
  v_tracking text := nullif(regexp_replace(coalesce(p_tracking_number, ''), '\s+', '', 'g'), '');
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then
    raise exception 'ADMIN_REQUIRED';
  end if;
  if v_tracking is not null and v_tracking !~ '^[A-Za-z0-9-]{1,40}$' then
    raise exception 'INVALID_TRACKING_NUMBER';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.delivery_method <> 'cvs_delivery' then raise exception 'TRACKING_NUMBER_CVS_ONLY'; end if;
  if v_order.status in ('cancelled', 'refunded') then raise exception 'ORDER_FULFILLMENT_NOT_EDITABLE'; end if;

  update public.orders
     set shipment_tracking_number = v_tracking,
         updated_at = now()
   where id = p_order_id;
  return jsonb_build_object('id', p_order_id, 'shipment_tracking_number', v_tracking);
end;
$function$;

revoke all on function public.admin_set_order_shipment_tracking(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_set_order_shipment_tracking(uuid, uuid, text) to service_role;

commit;
