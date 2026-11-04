-- 潮吉好頑：規格可設定前台是否顯示庫存數量（業主決策 2026-10-24）。
-- 1. product_variants.show_stock：預設現貨不顯示、預購顯示；既有規格依類型回填。只影響前台文字，
--    可售數量、限購與售完判斷照舊使用 storefront_variants.stock。
-- 2. storefront_variants 在尾端追加 show_stock（create or replace view 只能在尾端新增欄位），並補欄位 SELECT 授權。
-- 3. admin_create_product／admin_create_variant 加 p_show_stock（null＝依類型預設）、admin_update_variant 加 p_show_stock（null＝不變）；
--    舊簽名一併移除，避免 overload 歧義。新參數都有預設值，先套用本 migration 再部署 Worker 時舊 Worker 仍可呼叫。
-- 其餘規則與 202610160001_product_delivery_methods.sql、202610120003_variant_initial_stock.sql、
-- 202610010002_sku_optional_variant_name_unique.sql 的定義相同。

begin;

alter table public.product_variants
  add column if not exists show_stock boolean not null default false;
comment on column public.product_variants.show_stock is '前台是否顯示庫存數量；只影響顯示，不影響可售數量';

update public.product_variants set show_stock = (kind = 'preorder');

grant select (show_stock) on table public.product_variants to anon, authenticated;

-- 與 202610160001 相同，只在最後追加 show_stock
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
  p.allowed_delivery_methods,
  v.show_stock
from public.product_variants v
join public.products p on p.id = v.product_id
left join public.categories c on c.id = p.category_id;

revoke all on public.storefront_variants from anon, authenticated;
grant select on public.storefront_variants to anon, authenticated;

drop function public.admin_create_product(uuid,text,text,text,text,text,public.product_kind,integer,integer,text,numeric,text,boolean,integer,boolean,integer,text[]);
create function public.admin_create_product(
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
  p_delivery_methods text[] default null,
  p_show_stock boolean default null
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
  insert into public.product_variants(product_id, name, sku, kind, price, compare_at_price, stock_on_hand, preorder_arrival, deposit_rate, seller_link, is_published, display_order, show_stock)
  values (v_product.id, coalesce(nullif(trim(p_variant_name), ''), '單一規格'), coalesce(nullif(upper(trim(p_sku)), ''), 'V-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))), p_kind, p_price, p_compare_at_price, p_stock,
          nullif(trim(p_preorder_arrival), ''), p_deposit_rate, nullif(trim(p_seller_link), ''), p_is_published,
          coalesce((select max(display_order) + 1 from public.product_variants), 1), coalesce(p_show_stock, p_kind = 'preorder'))
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

drop function public.admin_create_variant(uuid,uuid,text,text,public.product_kind,integer,integer,integer,text,numeric,text,boolean,integer,integer);
create function public.admin_create_variant(
  p_actor_id uuid, p_product_id uuid, p_name text, p_sku text, p_kind public.product_kind,
  p_price integer, p_compare_at_price integer, p_safety_stock integer, p_preorder_arrival text,
  p_deposit_rate numeric, p_seller_link text, p_is_published boolean, p_display_order integer,
  p_stock integer default 0, p_show_stock boolean default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_row public.product_variants%rowtype; v_order integer; v_constraint text; v_stock integer := coalesce(p_stock, 0);
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if not exists (select 1 from public.products where id = p_product_id) then raise exception 'PRODUCT_NOT_FOUND'; end if;
  if nullif(trim(p_name), '') is null or p_price < 0 or coalesce(p_safety_stock, 0) < 0 or v_stock < 0
     or p_deposit_rate < 0 or p_deposit_rate > 1
     or (p_kind = 'preorder' and p_deposit_rate <> 0.5)
     or (p_compare_at_price is not null and (p_compare_at_price < 0 or p_compare_at_price < p_price)) then raise exception 'INVALID_VARIANT'; end if;
  -- 未指定排序：取全站規格最大值 + 1（排在前台最前面、數字不重複）；有指定則照用。
  perform pg_advisory_xact_lock(hashtext('public.product_variants.display_order'));
  v_order := coalesce(p_display_order, (select max(display_order) + 1 from public.product_variants), 1);
  insert into public.product_variants(product_id, name, sku, kind, price, compare_at_price, stock_on_hand, safety_stock, preorder_arrival, deposit_rate, seller_link, is_published, display_order, show_stock)
  values (p_product_id, trim(p_name), coalesce(nullif(upper(trim(p_sku)), ''), 'V-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))), p_kind, p_price, p_compare_at_price, v_stock, coalesce(p_safety_stock, 3), nullif(trim(p_preorder_arrival), ''), p_deposit_rate, nullif(trim(p_seller_link), ''), coalesce(p_is_published, false), v_order, coalesce(p_show_stock, p_kind = 'preorder'))
  returning * into v_row;
  if v_stock > 0 then
    insert into public.inventory_movements(variant_id, kind, quantity_delta, reason, actor_id)
    values (v_row.id, 'stock_in', v_stock, '新增規格初始庫存', p_actor_id);
  end if;
  perform public.append_audit_log(p_actor_id, 'create', 'product_variant', v_row.id::text, null, to_jsonb(v_row));
  return to_jsonb(v_row);
exception when unique_violation then
  get stacked diagnostics v_constraint = constraint_name;
  if v_constraint = 'product_variants_product_name_key' then raise exception 'VARIANT_NAME_EXISTS'; end if;
  raise exception 'SKU_EXISTS';
end;
$function$;

drop function public.admin_update_variant(uuid,uuid,text,text,public.product_kind,integer,integer,boolean,integer,text,numeric,text,boolean,integer);
create function public.admin_update_variant(
  p_actor_id uuid, p_variant_id uuid, p_name text, p_sku text, p_kind public.product_kind,
  p_price integer, p_compare_at_price integer, p_update_compare_at_price boolean, p_safety_stock integer,
  p_preorder_arrival text, p_deposit_rate numeric, p_seller_link text, p_is_published boolean, p_display_order integer,
  p_show_stock boolean default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_before public.product_variants%rowtype; v_after public.product_variants%rowtype; v_compare integer; v_constraint text;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  select * into v_before from public.product_variants where id = p_variant_id for update;
  if not found then raise exception 'VARIANT_NOT_FOUND'; end if;
  if nullif(trim(p_name), '') is null or p_price < 0 or coalesce(p_safety_stock, 0) < 0
     or p_deposit_rate < 0 or p_deposit_rate > 1
     or (p_kind = 'preorder' and p_deposit_rate <> 0.5) then raise exception 'INVALID_VARIANT'; end if;
  v_compare := case when coalesce(p_update_compare_at_price, true) then p_compare_at_price else v_before.compare_at_price end;
  if v_compare is not null and (v_compare < 0 or v_compare < p_price) then raise exception 'INVALID_COMPARE_AT_PRICE'; end if;
  -- 排序可為負數（新商品自動排最前面時會出現）；未提供時保留原值
  update public.product_variants
     set name = trim(p_name), sku = coalesce(nullif(upper(trim(p_sku)), ''), v_before.sku), kind = p_kind, price = p_price, compare_at_price = v_compare,
         safety_stock = coalesce(p_safety_stock, 3), preorder_arrival = nullif(trim(p_preorder_arrival), ''), deposit_rate = p_deposit_rate,
         seller_link = nullif(trim(p_seller_link), ''), is_published = coalesce(p_is_published, false), display_order = coalesce(p_display_order, v_before.display_order),
         show_stock = coalesce(p_show_stock, v_before.show_stock), updated_at = now()
   where id = p_variant_id returning * into v_after;
  perform public.append_audit_log(p_actor_id, 'update', 'product_variant', p_variant_id::text, to_jsonb(v_before), to_jsonb(v_after));
  return to_jsonb(v_after);
exception when unique_violation then
  get stacked diagnostics v_constraint = constraint_name;
  if v_constraint = 'product_variants_product_name_key' then raise exception 'VARIANT_NAME_EXISTS'; end if;
  raise exception 'SKU_EXISTS';
end;
$function$;

revoke all on function public.admin_create_product(uuid,text,text,text,text,text,public.product_kind,integer,integer,text,numeric,text,boolean,integer,boolean,integer,text[],boolean) from public, anon, authenticated;
grant execute on function public.admin_create_product(uuid,text,text,text,text,text,public.product_kind,integer,integer,text,numeric,text,boolean,integer,boolean,integer,text[],boolean) to service_role;
revoke all on function public.admin_create_variant(uuid,uuid,text,text,public.product_kind,integer,integer,integer,text,numeric,text,boolean,integer,integer,boolean) from public, anon, authenticated;
grant execute on function public.admin_create_variant(uuid,uuid,text,text,public.product_kind,integer,integer,integer,text,numeric,text,boolean,integer,integer,boolean) to service_role;
revoke all on function public.admin_update_variant(uuid,uuid,text,text,public.product_kind,integer,integer,boolean,integer,text,numeric,text,boolean,integer,boolean) from public, anon, authenticated;
grant execute on function public.admin_update_variant(uuid,uuid,text,text,public.product_kind,integer,integer,boolean,integer,text,numeric,text,boolean,integer,boolean) to service_role;

commit;
