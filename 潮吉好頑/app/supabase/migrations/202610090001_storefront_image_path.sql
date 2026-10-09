-- 潮吉好頑：公開型錄提供主圖路徑。
-- 商品圖片改放 R2 公開網域（img.767780.xyz）後，Worker 要用主圖路徑組出圖片網址；
-- 路徑每次上傳都是新的隨機檔名，只透過 storefront_variants 提供已上架商品（products RLS 只開放 is_published）。

begin;

-- storefront_variants 是 security_invoker view，anon／authenticated 需要底層欄位的 SELECT 權限
grant select (image_path) on table public.products to anon, authenticated;

-- 與 202610080002 相同，只在最後追加 image_path（create or replace view 只能在尾端新增欄位）
create or replace view 只能在尾端新增欄位）
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
  p.image_path
from public.product_variants v
join public.products p on p.id = v.product_id
left join public.categories c on c.id = p.category_id;

revoke all on public.storefront_variants from anon, authenticated;
grant select on public.storefront_variants to anon, authenticated;

commit;
