-- 潮吉好頑：已刪除（封存）商品的防護，補 202610100002。
-- 1. 封存後不可再上架：既有 admin_update_product／admin_update_variant 等 RPC 不檢查 archived_at，
--    另一個後台分頁保留舊資料按儲存時會把商品重新上架。以 trigger 在資料表層攔截，所有寫入路徑一致。
--    誤刪復原仍可由 SQL 先將 archived_at 設回 null 再上架。
-- 2. 會員購物車只能放上架中的商品：replace_member_cart 的上架檢查沒有鎖，可能與封存交錯，
--    在封存清除購物車後又寫入。trigger 以 for share 鎖定規格再檢查，與封存的 for update 互斥，
--    封存先完成時同步失敗（CART_PRODUCT_NOT_FOUND，前端重新整理購物車），同步先完成時封存會清掉它。
-- 3. 優惠券選單保留仍綁在優惠券上的已刪除商品（標記 archived），編輯優惠券時原本的適用商品不會被清空，
--    否則限定商品券會在儲存後變成全站適用。其餘選單（庫存調整、新增規格）由前端排除。

begin;

create or replace function private.archived_product_stays_unpublished()
returns trigger
language plpgsql security definer set search_path = ''
as $function$
begin
  if tg_table_name = 'products' then
    if new.archived_at is not null and new.is_published then raise exception 'PRODUCT_ARCHIVED'; end if;
  elsif new.is_published and exists (select 1 from public.products where id = new.product_id and archived_at is not null) then
    raise exception 'PRODUCT_ARCHIVED';
  end if;
  return new;
end;
$function$;

drop trigger if exists products_archived_stays_unpublished on public.products;
create trigger products_archived_stays_unpublished
  before insert or update of is_published, archived_at on public.products
  for each row execute function private.archived_product_stays_unpublished();

drop trigger if exists product_variants_archived_stays_unpublished on public.product_variants;
create trigger product_variants_archived_stays_unpublished
  before insert or update of is_published, product_id on public.product_variants
  for each row execute function private.archived_product_stays_unpublished();

create or replace function private.member_cart_item_on_sale()
returns trigger
language plpgsql security definer set search_path = ''
as $function$
begin
  perform 1
     from public.product_variants v
     join public.products p on p.id = v.product_id
    where v.id = new.variant_id and v.is_published and p.is_published and p.archived_at is null
    for share of v;
  if not found then raise exception 'CART_PRODUCT_NOT_FOUND'; end if;
  return new;
end;
$function$;

drop trigger if exists member_cart_items_on_sale on public.member_cart_items;
create trigger member_cart_items_on_sale
  before insert or update of variant_id on public.member_cart_items
  for each row execute function private.member_cart_item_on_sale();

revoke all on function private.archived_product_stays_unpublished() from public, anon, authenticated;
revoke all on function private.member_cart_item_on_sale() from public, anon, authenticated;

-- 管理表單選單：未刪除商品＋仍綁在優惠券上的已刪除商品（archived: true）；其餘與 202610100002 相同。
create or replace function public.admin_management_options(p_actor_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_products jsonb; v_members jsonb; v_categories jsonb;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'name', p.name, 'category_id', p.category_id, 'archived', p.archived_at is not null,
    'product_variants', coalesce((select jsonb_agg(jsonb_build_object(
      'id', v.id, 'name', v.name, 'sku', v.sku, 'kind', v.kind, 'price', v.price,
      'compare_at_price', v.compare_at_price, 'stock_on_hand', v.stock_on_hand, 'safety_stock', v.safety_stock,
      'preorder_arrival', v.preorder_arrival, 'deposit_rate', v.deposit_rate, 'seller_link', v.seller_link,
      'is_published', v.is_published, 'display_order', v.display_order
    ) order by v.display_order, v.created_at, v.id) from public.product_variants v where v.product_id = p.id), '[]'::jsonb)
  ) order by p.display_order, p.created_at, p.id), '[]'::jsonb) into v_products
    from public.products p left join public.categories c on c.id = p.category_id
   where p.archived_at is null or exists (select 1 from public.coupon_products cp where cp.product_id = p.id);
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'full_name', p.full_name, 'phone', p.phone) order by p.created_at desc, p.id desc), '[]'::jsonb) into v_members from public.profiles p;
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'display_order', c.display_order, 'is_active', c.is_active) order by c.display_order, c.name, c.id), '[]'::jsonb) into v_categories from public.categories c;
  return jsonb_build_object('products', v_products, 'members', v_members, 'categories', v_categories);
end;
$function$;

commit;
