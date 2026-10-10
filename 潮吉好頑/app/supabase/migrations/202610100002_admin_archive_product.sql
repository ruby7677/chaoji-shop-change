-- 潮吉好頑：後台「刪除商品」以封存實作。
-- 規格被訂單明細、庫存異動與保留量以 on delete restrict 參照，實體刪除會破壞訂單與庫存歷程，
-- 因此刪除＝標記 archived_at、商品與規格下架、移除會員購物車內的該商品，並從後台列表與管理選單隱藏。
-- 訂單、庫存異動與稽核紀錄完整保留；誤刪時可由 SQL 將 archived_at 設回 null 後在後台重新上架。
-- 還有未完成（非 completed／cancelled／refunded）訂單的商品不可刪除。
-- 下單（create_delivery_order）以 for update 鎖定已上架規格；這裡先鎖同一批規格再檢查訂單，
-- 同時進行的下單會在鎖釋放後看到規格已下架而失敗，不會在刪除後成立新訂單。

begin;

alter table public.products add column if not exists archived_at timestamptz;

create or replace function public.admin_archive_product(p_actor_id uuid, p_product_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_before public.products%rowtype;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  select * into v_before from public.products where id = p_product_id and archived_at is null for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
  perform 1 from public.product_variants where product_id = p_product_id order by id for update;
  if exists (
    select 1
      from public.order_items oi
      join public.orders o on o.id = oi.order_id
      join public.product_variants v on v.id = oi.variant_id
     where v.product_id = p_product_id
       and o.status not in ('completed', 'cancelled', 'refunded')
  ) then
    raise exception 'PRODUCT_HAS_OPEN_ORDERS';
  end if;
  update public.product_variants set is_published = false, updated_at = now() where product_id = p_product_id;
  delete from public.member_cart_items c using public.product_variants v where v.id = c.variant_id and v.product_id = p_product_id;
  update public.products set archived_at = now(), is_published = false, hero_rank = null, updated_at = now() where id = p_product_id;
  perform public.append_audit_log(p_actor_id, 'delete', 'product', p_product_id::text,
    jsonb_build_object('name', v_before.name, 'is_published', v_before.is_published, 'hero_rank', v_before.hero_rank),
    jsonb_build_object('archived', true));
  return jsonb_build_object('product_id', p_product_id, 'image_updated_at', v_before.image_updated_at);
end;
$function$;

revoke all on function public.admin_archive_product(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_archive_product(uuid, uuid) to service_role;

-- 後台商品列表：排除已刪除（封存）的商品；其餘與 202610090002 相同。
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
       where p.archived_at is null
         and (v_category = 'all' or (v_category = 'none' and p.category_id is null) or p.category_id = v_category_id)
         and ((v_status = 'all' and v_kind = 'all')
           or exists (
             select 1 from public.product_variants v
              where v.product_id = p.id
                and (v_kind = 'all' or v.kind::text = v_kind)
                and (v_status = 'all'
                  or (v_status = 'published' and p.is_published and v.is_published)
                  or (v_status = 'unpublished' and not (p.is_published and v.is_published))
                  or (v_status = 'sale' and v.price > 0 and coalesce(v.compare_at_price, 0) > v.price
                    and round((1 - v.price::numeric / v.compare_at_price) * 100) > 0))))
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

-- 管理表單選單（優惠券適用商品、庫存調整、新增規格）：排除已刪除商品；其餘與 202609220006 相同。
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
    from public.products p left join public.categories c on c.id = p.category_id
   where p.archived_at is null;
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'full_name', p.full_name, 'phone', p.phone) order by p.created_at desc, p.id desc), '[]'::jsonb) into v_members from public.profiles p;
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'display_order', c.display_order, 'is_active', c.is_active) order by c.display_order, c.name, c.id), '[]'::jsonb) into v_categories from public.categories c;
  return jsonb_build_object('products', v_products, 'members', v_members, 'categories', v_categories);
end;
$function$;

comment on function public.admin_archive_product(uuid, uuid) is
  '後台刪除商品（封存）：有未完成訂單時拒絕；下架商品與規格、清除會員購物車、寫入稽核，保留訂單與庫存歷程';

commit;
