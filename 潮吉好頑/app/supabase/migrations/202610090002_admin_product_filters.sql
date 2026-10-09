-- 潮吉好頑：後台商品列表的分類、類型、上架狀態與限時優惠篩選改在資料庫做，篩完再分頁。
-- 原本伺服器先分頁、後台只篩選目前這一頁，未上架商品排序在後面時第 1 頁會是空的。
-- 「已上架／未上架／限時優惠」以規格判斷，與後台列表一致：
--   已上架：商品與規格都上架；未上架：商品或規格任一未上架；限時優惠：原價大於售價且售價大於 0。
-- 類型與狀態必須落在同一個規格上（例如「預購＋未上架」= 有一個未上架的預購規格）。
-- 沒有規格的商品只在類型與狀態都是「全部」時列出。
-- 新增兩個參數，舊的 5 參數版本移除（Worker 以具名參數呼叫，新參數有預設值，舊版 Worker 仍可呼叫）。

begin;

drop function if exists public.admin_search_product_ids(uuid, text, text, integer, integer);

create or replace function public.admin_search_product_ids(
  p_actor_id uuid,
  p_query text default '',
  p_status text default 'all',
  p_page integer default 0,
  p_page_size integer default 100,
  p_category text default 'all',
  p_kind text default 'all'
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare
  v_query text := trim(coalesce(p_query, ''));
  v_status text := lower(trim(coalesce(p_status, 'all')));
  v_category text := lower(trim(coalesce(p_category, 'all')));
  v_kind text := lower(trim(coalesce(p_kind, 'all')));
  v_category_id uuid;
  v_page integer := greatest(least(coalesce(p_page, 0), 100000), 0);
  v_size integer := greatest(1, least(coalesce(p_page_size, 100), 100));
  v_ids uuid[];
  v_more boolean;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if v_status not in ('all', 'published', 'unpublished', 'sale') then raise exception 'INVALID_ADMIN_PRODUCT_FILTER'; end if;
  if v_kind not in ('all', 'in_stock', 'preorder') then raise exception 'INVALID_ADMIN_PRODUCT_FILTER'; end if;
  if v_category not in ('all', 'none') then
    if v_category !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'INVALID_ADMIN_PRODUCT_FILTER'; end if;
    v_category_id := v_category::uuid;
  end if;
  v_query := replace(replace(replace(v_query, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_');
  select coalesce(array_agg(s.id order by s.ord), '{}'::uuid[]) into v_ids
    from (
      select p.id, row_number() over (order by (select max(v.display_order) from public.product_variants v where v.product_id = p.id) desc nulls last, p.created_at desc, p.id desc) as ord
        from public.products p
        left join public.categories c on c.id = p.category_id
       where (v_category = 'all' or (v_category = 'none' and p.category_id is null) or p.category_id = v_category_id)
         and ((v_status = 'all' and v_kind = 'all')
           or exists (
             select 1 from public.product_variants v
              where v.product_id = p.id
                and (v_kind = 'all' or v.kind::text = v_kind)
                and (v_status = 'all'
                  or (v_status = 'published' and p.is_published and v.is_published)
                  or (v_status = 'unpublished' and not (p.is_published and v.is_published))
                  or (v_status = 'sale' and v.price > 0 and coalesce(v.compare_at_price, 0) > v.price))))
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

revoke all on function public.admin_search_product_ids(uuid, text, text, integer, integer, text, text) from public, anon, authenticated;
grant execute on function public.admin_search_product_ids(uuid, text, text, integer, integer, text, text) to service_role;

commit;
