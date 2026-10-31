-- 潮吉好頑：商品可設定可用的取貨方式（業主決策 2026-10-16）。
-- 有些商品太大只能宅配或到店取貨，管理員在商品上取消不適用的取貨方式，客人就不能選，不必取消訂單再重建。
-- 1. products.allowed_delivery_methods：至少一種，只能是 store_pickup／cvs_delivery／home_delivery；既有商品維持三種全開。
-- 2. storefront_variants 在尾端追加欄位，前台購物車據此只顯示每組商品共同允許的取貨方式。
-- 3. create_delivery_order 核心逐項檢查所選取貨方式（DELIVERY_METHOD_NOT_ALLOWED），這是最終限制；前台與 Worker 只負責提示。
-- 4. admin_create_product 加 p_delivery_methods（預設 null＝三種全開）、admin_update_product 加 p_delivery_methods（null＝不變）；
--    舊簽名一併移除，避免 overload 歧義。新參數都有預設值，先套用本 migration 再部署 Worker 時舊 Worker 仍可呼叫。
-- 已建立的訂單不受影響（訂單只記錄建單當下的 delivery_method）。

begin;

alter table public.products
  add column if not exists allowed_delivery_methods text[] not null
  default array['store_pickup', 'cvs_delivery', 'home_delivery']::text[];

alter table public.products drop constraint if exists products_allowed_delivery_methods_check;
alter table public.products add constraint products_allowed_delivery_methods_check check (
  cardinality(allowed_delivery_methods) between 1 and 3
  and allowed_delivery_methods <@ array['store_pickup', 'cvs_delivery', 'home_delivery']::text[]
);

comment on column public.products.allowed_delivery_methods is
  '此商品建單時可選的取貨方式（store_pickup／cvs_delivery／home_delivery，至少一種）；購物車內同組商品需有共同方式才能結帳';

-- storefront_variants 是 security_invoker view，anon／authenticated 需要底層欄位的 SELECT 權限
grant select (allowed_delivery_methods) on table public.products to anon, authenticated;

-- 驗證並正規化（去重、排序）；null 代表呼叫端沒有指定。
create or replace function private.normalize_delivery_methods(p_methods text[])
returns text[]
language plpgsql
immutable
set search_path = ''
as $function$
begin
  if p_methods is null then return null; end if;
  if cardinality(p_methods) = 0
     or not coalesce(p_methods <@ array['store_pickup', 'cvs_delivery', 'home_delivery']::text[], false) then
    raise exception 'INVALID_DELIVERY_METHODS';
  end if;
  return (select array_agg(distinct m order by m) from unnest(p_methods) as m);
end;
$function$;
revoke all on function private.normalize_delivery_methods(text[]) from public, anon, authenticated;

-- 與 202610090001 相同，只在最後追加 allowed_delivery_methods（create or replace view 只能在尾端新增欄位）
create or replace view public.storefront_variants with (security_invoker = true) as
select
  v.id::text,
  c.name as category,
  p.name || case when v.name = '單一規格' then '' else ' · ' || v.name end as name,
  v.price,
  private.storefront_available_stock(v.id) as stock,
  case when v.kind = 'in_stock' then '現貨' else '預購' end as type,
  v.preorder_arrival,
  v.seller_link,
  v.display_order,
  v.is_published,
  p.id::text as product_id,
  (p.image_path is not null) as has_image,
  p.image_updated_at,
  v.shipping_units,
  p.name as product_name,
  p.description,
  v.name as variant_name,
  p.purchase_limit,
  p.points_eligible,
  v.compare_at_price,
  p.hero_rank,
  p.hero_tagline,
  p.image_width,
  p.image_height,
  p.image_path,
  p.allowed_delivery_methods
from public.product_variants v
join public.products p on p.id = v.product_id
left join public.categories c on c.id = p.category_id;

revoke all on public.storefront_variants from anon, authenticated;
grant select on public.storefront_variants to anon, authenticated;

-- 下單核心：與 202610110001 相同，另加「所選取貨方式必須是每項商品允許的」檢查。
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
    select v.*, p.name as product_name, p.id as parent_product_id, p.allowed_delivery_methods
      into v_variant
      from public.product_variants v
      join public.products p on p.id = v.product_id
     where v.id = v_item.variant_id and v.is_published and p.is_published
     for update of v;
    if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
    if not (p_delivery_method = any(v_variant.allowed_delivery_methods)) then raise exception 'DELIVERY_METHOD_NOT_ALLOWED'; end if;
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

-- 商品建立：新增 p_delivery_methods；舊 16 參數版移除。
drop function if exists public.admin_create_product(uuid,text,text,text,text,text,public.product_kind,integer,integer,text,numeric,text,boolean,integer,boolean,integer);
create or replace function public.admin_create_product(
  p_actor_id uuid,
  p_category_name text,
  p_product_name text,
  p_description text,
  p_variant_name text,
  p_sku text,
  p_kind public.product_kind,
  p_price integer,
  p_stock integer,
  p_preorder_arrival text,
  p_deposit_rate numeric,
  p_seller_link text,
  p_is_published boolean,
  p_purchase_limit integer default null,
  p_points_eligible boolean default true,
  p_compare_at_price integer default null,
  p_delivery_methods text[] default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare
  v_category_id uuid;
  v_product_id uuid;
  v_variant_id uuid;
  v_category_created boolean := false;
  v_product public.products%rowtype;
  v_variant public.product_variants%rowtype;
  v_constraint text;
  v_methods text[] := private.normalize_delivery_methods(p_delivery_methods);
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if nullif(trim(p_category_name), '') is null or nullif(trim(p_product_name), '') is null then raise exception 'REQUIRED_FIELDS_MISSING'; end if;
  if p_price < 0 or p_stock < 0 then raise exception 'INVALID_NUMBER'; end if;
  if p_compare_at_price is not null and (p_compare_at_price < 0 or p_compare_at_price < p_price) then raise exception 'INVALID_COMPARE_AT_PRICE'; end if;
  if p_purchase_limit is not null and p_purchase_limit < 1 then raise exception 'INVALID_PURCHASE_LIMIT'; end if;
  if p_deposit_rate < 0 or p_deposit_rate > 1 then raise exception 'INVALID_DEPOSIT_RATE'; end if;
  if p_kind = 'preorder' and p_deposit_rate <> 0.5 then raise exception 'PREORDER_DEPOSIT_MUST_BE_HALF'; end if;

  insert into public.categories(name, display_order)
  values (trim(p_category_name), coalesce((select max(display_order) + 10 from public.categories), 10))
  on conflict (name) do update set name = excluded.name
  returning id, (xmax = 0) into v_category_id, v_category_created;

  insert into public.products(category_id, name, description, is_published, display_order, purchase_limit, points_eligible, allowed_delivery_methods)
  values (v_category_id, trim(p_product_name), coalesce(p_description, ''), p_is_published,
          coalesce((select max(display_order) + 10 from public.products), 10), p_purchase_limit, coalesce(p_points_eligible, true),
          coalesce(v_methods, array['store_pickup', 'cvs_delivery', 'home_delivery']::text[]))
  returning * into v_product;

  -- 前台排序數字越大越前面：新商品取目前所有規格（含未上架）的最大值 + 1，排在最前面且不與既有數字重複。
  -- 交易層級鎖讓同時建立的兩筆不會拿到同一個數字。
  perform pg_advisory_xact_lock(hashtext('public.product_variants.display_order'));
  insert into public.product_variants(product_id, name, sku, kind, price, compare_at_price, stock_on_hand, preorder_arrival, deposit_rate, seller_link, is_published, display_order)
  values (v_product.id, coalesce(nullif(trim(p_variant_name), ''), '單一規格'), coalesce(nullif(upper(trim(p_sku)), ''), 'V-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))), p_kind, p_price, p_compare_at_price, p_stock,
          nullif(trim(p_preorder_arrival), ''), p_deposit_rate, nullif(trim(p_seller_link), ''), p_is_published,
          coalesce((select max(display_order) + 1 from public.product_variants), 1))
  returning * into v_variant;

  if p_stock > 0 then
    insert into public.inventory_movements(variant_id, kind, quantity_delta, reason, actor_id)
    values (v_variant.id, 'stock_in', p_stock, '建立商品初始庫存', p_actor_id);
  end if;
  if v_category_created then perform public.append_audit_log(p_actor_id, 'create', 'category', v_category_id::text, null, (select to_jsonb(c) from public.categories c where c.id = v_category_id)); end if;
  perform public.append_audit_log(p_actor_id, 'create', 'product', v_product.id::text, null, to_jsonb(v_product));
  perform public.append_audit_log(p_actor_id, 'create', 'product_variant', v_variant.id::text, null, to_jsonb(v_variant));
  return jsonb_build_object('product_id', v_product.id, 'variant_id', v_variant.id);
exception when unique_violation then
  get stacked diagnostics v_constraint = constraint_name;
  if v_constraint = 'product_variants_product_name_key' then raise exception 'VARIANT_NAME_EXISTS'; end if;
  raise exception 'SKU_EXISTS';
end;
$function$;

-- 商品編輯：新增 p_delivery_methods（null＝不變）；舊 9 參數版移除。
drop function if exists public.admin_update_product(uuid,uuid,text,text,uuid,integer,boolean,boolean,integer);
create or replace function public.admin_update_product(
  p_actor_id uuid, p_product_id uuid, p_name text, p_description text, p_category_id uuid,
  p_purchase_limit integer, p_points_eligible boolean, p_is_published boolean, p_display_order integer,
  p_delivery_methods text[] default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_before public.products%rowtype; v_after public.products%rowtype; v_methods text[] := private.normalize_delivery_methods(p_delivery_methods);
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  select * into v_before from public.products where id = p_product_id for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
  if nullif(trim(p_name), '') is null or (p_purchase_limit is not null and p_purchase_limit < 1) or coalesce(p_display_order, 0) < 0 then raise exception 'INVALID_PRODUCT'; end if;
  if p_category_id is not null and not exists (select 1 from public.categories where id = p_category_id and is_active) then raise exception 'INVALID_CATEGORY'; end if;
  update public.products
     set name = trim(p_name), description = coalesce(p_description, ''), category_id = p_category_id,
         purchase_limit = p_purchase_limit, points_eligible = coalesce(p_points_eligible, v_before.points_eligible), is_published = coalesce(p_is_published, false),
         allowed_delivery_methods = coalesce(v_methods, v_before.allowed_delivery_methods),
         display_order = coalesce(p_display_order, 0), updated_at = now()
   where id = p_product_id returning * into v_after;
  perform public.append_audit_log(p_actor_id, 'update', 'product', p_product_id::text, to_jsonb(v_before), to_jsonb(v_after));
  return to_jsonb(v_after);
end;
$function$;

revoke all on function public.admin_create_product(uuid,text,text,text,text,text,public.product_kind,integer,integer,text,numeric,text,boolean,integer,boolean,integer,text[]) from public, anon, authenticated;
grant execute on function public.admin_create_product(uuid,text,text,text,text,text,public.product_kind,integer,integer,text,numeric,text,boolean,integer,boolean,integer,text[]) to service_role;
revoke all on function public.admin_update_product(uuid,uuid,text,text,uuid,integer,boolean,boolean,integer,text[]) from public, anon, authenticated;
grant execute on function public.admin_update_product(uuid,uuid,text,text,uuid,integer,boolean,boolean,integer,text[]) to service_role;

commit;
