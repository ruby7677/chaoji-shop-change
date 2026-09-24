-- 管理後台商品／優惠券／庫存分頁搜尋與完整 options payload。
-- 所有 RPC 僅供 Worker service_role 使用，查詢條件固定白名單，沒有任意動態 SQL。

begin;

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
  select coalesce(array_agg(s.id), '{}'::uuid[]) into v_ids
    from (
      select p.id
        from public.products p
        left join public.categories c on c.id = p.category_id
       where (v_status = 'all' or (v_status = 'published' and p.is_published) or (v_status = 'unpublished' and not p.is_published))
         and (v_query = '' or p.name ilike '%' || v_query || '%' escape E'\\' or coalesce(p.description, '') ilike '%' || v_query || '%' escape E'\\' or coalesce(c.name, '') ilike '%' || v_query || '%' escape E'\\'
           or exists (select 1 from public.product_variants v where v.product_id = p.id and (v.name ilike '%' || v_query || '%' escape E'\\' or v.sku ilike '%' || v_query || '%' escape E'\\')))
       order by p.display_order asc, p.created_at desc, p.id desc
       limit v_size + 1 offset v_page * v_size
    ) s;
  v_more := cardinality(v_ids) > v_size;
  if v_more then v_ids := v_ids[1:v_size]; end if;
  return jsonb_build_object('ids', to_jsonb(v_ids), 'pagination', jsonb_build_object('page', v_page, 'pageSize', v_size, 'hasMore', v_more));
end;
$function$;

create or replace function public.admin_search_coupon_ids(
  p_actor_id uuid, p_query text default '', p_page integer default 0, p_page_size integer default 100
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_query text := trim(coalesce(p_query, '')); v_page integer := greatest(least(coalesce(p_page, 0), 100000), 0); v_size integer := greatest(1, least(coalesce(p_page_size, 100), 100)); v_ids uuid[]; v_more boolean;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  v_query := replace(replace(replace(v_query, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_');
  select coalesce(array_agg(s.id), '{}'::uuid[]) into v_ids
    from (
      select c.id from public.coupons c
       where v_query = '' or c.code ilike '%' || v_query || '%' escape E'\\' or c.name ilike '%' || v_query || '%' escape E'\\'
       order by c.created_at desc, c.id desc
       limit v_size + 1 offset v_page * v_size
    ) s;
  v_more := cardinality(v_ids) > v_size;
  if v_more then v_ids := v_ids[1:v_size]; end if;
  return jsonb_build_object('ids', to_jsonb(v_ids), 'pagination', jsonb_build_object('page', v_page, 'pageSize', v_size, 'hasMore', v_more));
end;
$function$;

create or replace function public.admin_search_inventory_movement_ids(
  p_actor_id uuid, p_variant_id uuid default null, p_page integer default 0, p_page_size integer default 100
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_page integer := greatest(least(coalesce(p_page, 0), 100000), 0); v_size integer := greatest(1, least(coalesce(p_page_size, 100), 100)); v_ids uuid[]; v_more boolean;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  select coalesce(array_agg(s.id), '{}'::uuid[]) into v_ids
    from (
      select im.id from public.inventory_movements im
       where p_variant_id is null or im.variant_id = p_variant_id
       order by im.created_at desc, im.id desc
       limit v_size + 1 offset v_page * v_size
    ) s;
  v_more := cardinality(v_ids) > v_size;
  if v_more then v_ids := v_ids[1:v_size]; end if;
  return jsonb_build_object('ids', to_jsonb(v_ids), 'pagination', jsonb_build_object('page', v_page, 'pageSize', v_size, 'hasMore', v_more));
end;
$function$;

create or replace function public.admin_management_options(p_actor_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_products jsonb; v_members jsonb; v_categories jsonb;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'name', p.name, 'category_id', p.category_id,
    'product_variants', coalesce((select jsonb_agg(jsonb_build_object(
      'id', v.id, 'name', v.name, 'sku', v.sku, 'kind', v.kind, 'price', v.price,
      'compare_at_price', v.compare_at_price, 'stock_on_hand', v.stock_on_hand, 'safety_stock', v.safety_stock,
      'preorder_arrival', v.preorder_arrival, 'deposit_rate', v.deposit_rate, 'seller_link', v.seller_link,
      'is_published', v.is_published, 'display_order', v.display_order
    ) order by v.display_order, v.created_at, v.id) from public.product_variants v where v.product_id = p.id), '[]'::jsonb)
  ) order by p.display_order, p.created_at, p.id), '[]'::jsonb) into v_products
    from public.products p left join public.categories c on c.id = p.category_id;
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'full_name', p.full_name, 'phone', p.phone) order by p.created_at desc, p.id desc), '[]'::jsonb) into v_members from public.profiles p;
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'display_order', c.display_order, 'is_active', c.is_active) order by c.display_order, c.name, c.id), '[]'::jsonb) into v_categories from public.categories c;
  return jsonb_build_object('products', v_products, 'members', v_members, 'categories', v_categories);
end;
$function$;

revoke all on function public.admin_search_product_ids(uuid,text,text,integer,integer) from public, anon, authenticated;
revoke all on function public.admin_search_coupon_ids(uuid,text,integer,integer) from public, anon, authenticated;
revoke all on function public.admin_search_inventory_movement_ids(uuid,uuid,integer,integer) from public, anon, authenticated;
revoke all on function public.admin_management_options(uuid) from public, anon, authenticated;
grant execute on function public.admin_search_product_ids(uuid,text,text,integer,integer) to service_role;
grant execute on function public.admin_search_coupon_ids(uuid,text,integer,integer) to service_role;
grant execute on function public.admin_search_inventory_movement_ids(uuid,uuid,integer,integer) to service_role;
grant execute on function public.admin_management_options(uuid) to service_role;

comment on function public.admin_search_product_ids(uuid,text,text,integer,integer) is '管理員商品名稱、分類、規格、SKU 與上架狀態搜尋分頁';
comment on function public.admin_management_options(uuid) is '管理表單完整商品、規格、分類與會員 options，不受清單分頁限制';

commit;
