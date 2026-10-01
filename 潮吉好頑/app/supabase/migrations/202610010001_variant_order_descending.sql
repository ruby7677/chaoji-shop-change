-- 前台排序改為「數字越大越前面」（業主 2026-10-01 決定）：
-- 1. 既有規格依目前前台顯示順序（舊規則：小到大，同數字以建立時間、id 決定）重新編號為不重複的 N…1，
--    原本排第一的拿到最大值，前台順序不變。
-- 2. 新增商品／新增規格未指定排序時，取全站規格最大值 + 1，排在最前面；以交易層級 advisory lock 避免同時建立拿到同號。
-- 3. 後台商品清單改依該商品規格的最大排序由大到小，與前台一致。
-- 管理員手動改成重複數字仍允許，前台以 id 作為同數字時的固定次序（見 catalog.ts）。

begin;

with ranked as (
  select id, row_number() over (order by display_order asc, created_at asc, id asc) as r, count(*) over () as n
    from public.product_variants
)
update public.product_variants v
   set display_order = ranked.n - ranked.r + 1
  from ranked
 where ranked.id = v.id
   and v.display_order is distinct from ranked.n - ranked.r + 1;

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
  p_compare_at_price integer default null
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
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if nullif(trim(p_category_name), '') is null or nullif(trim(p_product_name), '') is null or nullif(trim(p_sku), '') is null then raise exception 'REQUIRED_FIELDS_MISSING'; end if;
  if p_price < 0 or p_stock < 0 then raise exception 'INVALID_NUMBER'; end if;
  if p_compare_at_price is not null and (p_compare_at_price < 0 or p_compare_at_price < p_price) then raise exception 'INVALID_COMPARE_AT_PRICE'; end if;
  if p_purchase_limit is not null and p_purchase_limit < 1 then raise exception 'INVALID_PURCHASE_LIMIT'; end if;
  if p_deposit_rate < 0 or p_deposit_rate > 1 then raise exception 'INVALID_DEPOSIT_RATE'; end if;
  if p_kind = 'preorder' and p_deposit_rate <> 0.5 then raise exception 'PREORDER_DEPOSIT_MUST_BE_HALF'; end if;

  insert into public.categories(name, display_order)
  values (trim(p_category_name), coalesce((select max(display_order) + 10 from public.categories), 10))
  on conflict (name) do update set name = excluded.name
  returning id, (xmax = 0) into v_category_id, v_category_created;

  insert into public.products(category_id, name, description, is_published, display_order, purchase_limit, points_eligible)
  values (v_category_id, trim(p_product_name), coalesce(p_description, ''), p_is_published,
          coalesce((select max(display_order) + 10 from public.products), 10), p_purchase_limit, coalesce(p_points_eligible, true))
  returning * into v_product;

  -- 前台排序數字越大越前面：新商品取目前所有規格（含未上架）的最大值 + 1，排在最前面且不與既有數字重複。
  -- 交易層級鎖讓同時建立的兩筆不會拿到同一個數字。
  perform pg_advisory_xact_lock(hashtext('public.product_variants.display_order'));
  insert into public.product_variants(product_id, name, sku, kind, price, compare_at_price, stock_on_hand, preorder_arrival, deposit_rate, seller_link, is_published, display_order)
  values (v_product.id, coalesce(nullif(trim(p_variant_name), ''), '單一規格'), upper(trim(p_sku)), p_kind, p_price, p_compare_at_price, p_stock,
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
exception when unique_violation then raise exception 'SKU_EXISTS';
end;
$function$;


create or replace function public.admin_create_variant(
  p_actor_id uuid, p_product_id uuid, p_name text, p_sku text, p_kind public.product_kind,
  p_price integer, p_compare_at_price integer, p_safety_stock integer, p_preorder_arrival text,
  p_deposit_rate numeric, p_seller_link text, p_is_published boolean, p_display_order integer
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_row public.product_variants%rowtype; v_order integer;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if not exists (select 1 from public.products where id = p_product_id) then raise exception 'PRODUCT_NOT_FOUND'; end if;
  if nullif(trim(p_name), '') is null or nullif(trim(p_sku), '') is null or p_price < 0 or coalesce(p_safety_stock, 0) < 0
     or p_deposit_rate < 0 or p_deposit_rate > 1
     or (p_kind = 'preorder' and p_deposit_rate <> 0.5)
     or (p_compare_at_price is not null and (p_compare_at_price < 0 or p_compare_at_price < p_price)) then raise exception 'INVALID_VARIANT'; end if;
  -- 未指定排序：取全站規格最大值 + 1（排在前台最前面、數字不重複）；有指定則照用。
  perform pg_advisory_xact_lock(hashtext('public.product_variants.display_order'));
  v_order := coalesce(p_display_order, (select max(display_order) + 1 from public.product_variants), 1);
  insert into public.product_variants(product_id, name, sku, kind, price, compare_at_price, stock_on_hand, safety_stock, preorder_arrival, deposit_rate, seller_link, is_published, display_order)
  values (p_product_id, trim(p_name), upper(trim(p_sku)), p_kind, p_price, p_compare_at_price, 0, coalesce(p_safety_stock, 3), nullif(trim(p_preorder_arrival), ''), p_deposit_rate, nullif(trim(p_seller_link), ''), coalesce(p_is_published, false), v_order)
  returning * into v_row;
  perform public.append_audit_log(p_actor_id, 'create', 'product_variant', v_row.id::text, null, to_jsonb(v_row));
  return to_jsonb(v_row);
exception when unique_violation then raise exception 'SKU_EXISTS';
end;
$function$;


create or replace function public.admin_search_product_ids(
  p_actor_id uuid, p_query text default '', p_status text default 'all', p_page integer default 0, p_page_size integer default 100
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_query text := trim(coalesce(p_query, '')); v_status text := lower(trim(coalesce(p_status, 'all'))); v_page integer := greatest(least(coalesce(p_page, 0), 100000), 0); v_size integer := greatest(1, least(coalesce(p_page_size, 100), 100)); v_ids uuid[]; v_more boolean;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if v_status not in ('all', 'published', 'unpublished') then raise exception 'INVALID_ADMIN_PRODUCT_FILTER'; end if;
  v_query := replace(replace(replace(v_query, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_');
  select coalesce(array_agg(s.id order by s.ord), '{}'::uuid[]) into v_ids
    from (
      select p.id, row_number() over (order by (select max(v.display_order) from public.product_variants v where v.product_id = p.id) desc nulls last, p.created_at desc, p.id desc) as ord
        from public.products p
        left join public.categories c on c.id = p.category_id
       where (v_status = 'all' or (v_status = 'published' and p.is_published) or (v_status = 'unpublished' and not p.is_published))
         and (v_query = '' or p.name ilike '%' || v_query || '%' escape E'\\' or coalesce(p.description, '') ilike '%' || v_query || '%' escape E'\\' or coalesce(c.name, '') ilike '%' || v_query || '%' escape E'\\'
           or exists (select 1 from public.product_variants v where v.product_id = p.id and (v.name ilike '%' || v_query || '%' escape E'\\' or v.sku ilike '%' || v_query || '%' escape E'\\')))
       -- 與前台一致：依商品規格的最大前台排序由大到小
       order by (select max(v.display_order) from public.product_variants v where v.product_id = p.id) desc nulls last, p.created_at desc, p.id desc
       limit v_size + 1 offset v_page * v_size
    ) s;
  v_more := cardinality(v_ids) > v_size;
  if v_more then v_ids := v_ids[1:v_size]; end if;
  return jsonb_build_object('ids', to_jsonb(v_ids), 'pagination', jsonb_build_object('page', v_page, 'pageSize', v_size, 'hasMore', v_more));
end;
$function$;

revoke all on function public.admin_create_product(uuid,text,text,text,text,text,public.product_kind,integer,integer,text,numeric,text,boolean,integer,boolean,integer) from public, anon, authenticated;
revoke all on function public.admin_create_variant(uuid,uuid,text,text,public.product_kind,integer,integer,integer,text,numeric,text,boolean,integer) from public, anon, authenticated;
revoke all on function public.admin_search_product_ids(uuid,text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.admin_create_product(uuid,text,text,text,text,text,public.product_kind,integer,integer,text,numeric,text,boolean,integer,boolean,integer) to service_role;
grant execute on function public.admin_create_variant(uuid,uuid,text,text,public.product_kind,integer,integer,integer,text,numeric,text,boolean,integer) to service_role;
grant execute on function public.admin_search_product_ids(uuid,text,text,integer,integer) to service_role;

commit;
