-- 潮吉好頑：結帳取貨方式與宅配箱型運費。
-- 前置需求：202609100006_discounts.sql、202609100005_product_images.sql。
-- 可重複執行；既有訂單預設為到店取貨且運費為 0。

begin;

alter table public.product_variants
  add column if not exists shipping_units integer not null default 1;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.product_variants'::regclass
      and conname = 'product_variants_shipping_units_check'
  ) then
    alter table public.product_variants
      add constraint product_variants_shipping_units_check check (shipping_units > 0);
  end if;
end;
$$;

alter table public.orders
  add column if not exists delivery_method text not null default 'store_pickup',
  add column if not exists shipping_fee integer not null default 0,
  add column if not exists shipping_address text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_delivery_method_check'
  ) then
    alter table public.orders
      add constraint orders_delivery_method_check check (delivery_method in ('store_pickup', 'seller_delivery', 'home_delivery'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_shipping_fee_check'
  ) then
    alter table public.orders
      add constraint orders_shipping_fee_check check (shipping_fee >= 0);
  end if;
end;
$$;

create table if not exists public.shipping_settings (
  id boolean primary key default true check (id),
  seller_delivery_fee integer not null default 38 check (seller_delivery_fee >= 0),
  home_small_max_units integer not null default 3 check (home_small_max_units > 0),
  home_small_fee integer not null default 150 check (home_small_fee >= 0),
  home_large_max_units integer not null default 8 check (home_large_max_units >= home_small_max_units),
  home_large_fee integer not null default 250 check (home_large_fee >= 0),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.shipping_settings (id)
values (true)
on conflict (id) do nothing;

alter table public.shipping_settings enable row level security;

create or replace view public.storefront_variants with (security_invoker = true) as
select
  v.id::text,
  c.name as category,
  p.name || case when v.name = '單一規格' then '' else ' · ' || v.name end as name,
  v.price,
  greatest(
    v.stock_on_hand - coalesce((
      select sum(r.quantity)
      from public.inventory_reservations r
      where r.variant_id = v.id
        and r.released_at is null
        and r.expires_at > now()
    ), 0),
    0
  ) as stock,
  case when v.kind = 'in_stock' then '現貨' else '預購' end as type,
  v.preorder_arrival,
  v.seller_link,
  v.display_order,
  v.is_published,
  p.id::text as product_id,
  (p.image_path is not null) as has_image,
  p.image_updated_at,
  v.shipping_units
from public.product_variants v
join public.products p on p.id = v.product_id
left join public.categories c on c.id = p.category_id;

grant select on public.storefront_variants to anon, authenticated;

create or replace function public.calculate_shipping_fee(
  p_delivery_method text,
  p_shipping_units integer
)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_settings public.shipping_settings;
  v_boxes integer;
begin
  if p_delivery_method not in ('store_pickup', 'seller_delivery', 'home_delivery') then
    raise exception 'INVALID_DELIVERY_METHOD';
  end if;
  if coalesce(p_shipping_units, 0) < 0 then
    raise exception 'INVALID_SHIPPING_UNITS';
  end if;
  if p_delivery_method = 'store_pickup' then return 0; end if;

  select * into v_settings from public.shipping_settings where id = true;
  if not found then raise exception 'SHIPPING_SETTINGS_NOT_FOUND'; end if;
  if p_delivery_method = 'seller_delivery' then return v_settings.seller_delivery_fee; end if;
  if p_shipping_units = 0 then return 0; end if;
  if p_shipping_units <= v_settings.home_small_max_units then return v_settings.home_small_fee; end if;

  v_boxes := ceil(p_shipping_units::numeric / v_settings.home_large_max_units)::integer;
  return v_boxes * v_settings.home_large_fee;
end;
$$;

-- 新 RPC 保留舊 create_discounted_order 相容性，讓前端可帶入配送方式與地址。
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
  if coalesce(p_points_to_redeem, 0) < 0 then raise exception 'INVALID_POINTS'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'EMPTY_CART'; end if;
  if p_bank_account_id is null or not exists (select 1 from public.bank_accounts where id = p_bank_account_id and is_active) then raise exception 'BANK_ACCOUNT_REQUIRED'; end if;
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
  -- 宅配／賣貨便運費於建立訂單時一併收取，避免先出貨後才發現運費不足。
  v_deposit := least(greatest(v_product_deposit - v_coupon_discount - v_point_discount, 0), v_product_amount) + v_shipping_fee;

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
    v_subtotal, v_coupon_discount, v_point_discount, v_amount, v_deposit, now() + interval '24 hours',
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
    values (v_variant.id, v_order_id, v_item.quantity, now() + interval '24 hours');
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

create or replace function public.admin_update_shipping_settings(
  p_actor_id uuid,
  p_seller_delivery_fee integer,
  p_home_small_max_units integer,
  p_home_small_fee integer,
  p_home_large_max_units integer,
  p_home_large_fee integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if p_seller_delivery_fee < 0 or p_home_small_max_units <= 0 or p_home_small_fee < 0
     or p_home_large_max_units < p_home_small_max_units or p_home_large_fee < 0 then
    raise exception 'INVALID_SHIPPING_SETTINGS';
  end if;
  insert into public.shipping_settings(id, seller_delivery_fee, home_small_max_units, home_small_fee, home_large_max_units, home_large_fee, updated_by, updated_at)
  values (true, p_seller_delivery_fee, p_home_small_max_units, p_home_small_fee, p_home_large_max_units, p_home_large_fee, p_actor_id, now())
  on conflict (id) do update set
    seller_delivery_fee = excluded.seller_delivery_fee,
    home_small_max_units = excluded.home_small_max_units,
    home_small_fee = excluded.home_small_fee,
    home_large_max_units = excluded.home_large_max_units,
    home_large_fee = excluded.home_large_fee,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;
  return (select to_jsonb(s) from public.shipping_settings s where s.id = true);
end;
$$;

-- 運費是代收代付，不列入會員累積消費與消費入點。
create or replace view public.admin_member_summary as
select
  p.id,
  p.full_name,
  p.phone,
  p.birthday,
  p.address,
  p.is_admin,
  p.created_at,
  coalesce((select sum(pl.points) from public.point_ledger pl where pl.member_id = p.id), 0)::integer as point_balance,
  coalesce((select sum(greatest(o.amount_due - coalesce(o.shipping_fee, 0), 0)) from public.orders o where o.member_id = p.id and o.status = 'completed'), 0)::integer as lifetime_spend,
  (select count(*) from public.orders o where o.member_id = p.id)::integer as order_count
from public.profiles p;

create or replace function public.apply_points_from_order_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_earn_amount integer;
  v_points integer;
  v_balance_from_order integer;
begin
  select * into v_order from public.orders where id = new.order_id;
  if not found then return new; end if;

  if new.to_status = 'completed' and new.from_status <> 'completed' then
    select earn_amount_per_point into v_earn_amount from public.point_settings where id;
    v_points := floor(greatest(v_order.amount_due - coalesce(v_order.shipping_fee, 0), 0)::numeric / v_earn_amount)::integer;
    if v_points > 0 then
      insert into public.point_ledger(member_id, order_id, kind, points, reason, actor_id)
      values (v_order.member_id, v_order.id, 'earn', v_points, '完成訂單 ' || v_order.order_number || ' 自動入點', new.actor_id)
      on conflict (order_id) where kind = 'earn' and order_id is not null do nothing;
    end if;
  elsif new.to_status = 'refunded' then
    select coalesce(sum(points), 0)::integer into v_balance_from_order
      from public.point_ledger
     where order_id = v_order.id and kind in ('earn', 'reversal');
    if v_balance_from_order > 0 then
      insert into public.point_ledger(member_id, order_id, kind, points, reason, actor_id)
      values (v_order.member_id, v_order.id, 'reversal', -v_balance_from_order, '退款訂單 ' || v_order.order_number || ' 扣回點數', new.actor_id)
      on conflict (order_id) where kind = 'reversal' and order_id is not null do nothing;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.calculate_shipping_fee(text, integer) from public, anon, authenticated;
grant execute on function public.calculate_shipping_fee(text, integer) to authenticated;
revoke all on function public.create_delivery_order(jsonb, text, text, text, integer, uuid, text, text) from public, anon;
grant execute on function public.create_delivery_order(jsonb, text, text, text, integer, uuid, text, text) to authenticated;
revoke all on function public.admin_update_shipping_settings(uuid, integer, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.admin_update_shipping_settings(uuid, integer, integer, integer, integer, integer) to service_role;

commit;
