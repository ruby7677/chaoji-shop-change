-- 潮吉好頑：記錄商品主圖的原始寬高。
-- 首頁輪播在手機上依照片比例撐滿寬度；瀏覽器事先不知道比例時，照片載入後才把版面撐開，
-- 下方商品區整個往下跳（PageSpeed CLS 0.311）。Worker 上傳主圖時讀取檔頭寫入寬高，
-- 既有照片由排程補齊；前台用比例先保留照片空間。
-- 欄位允許 null：尚未補齊或無法辨識的照片維持原本依載入結果排版。

begin;

alter table public.products
  add column if not exists image_width integer check (image_width > 0),
  add column if not exists image_height integer check (image_height > 0);

-- storefront_variants 是 security_invoker view，anon／authenticated 需要底層欄位的 SELECT 權限
grant select (image_width, image_height) on table public.products to anon, authenticated;

-- 與 202609240001 相同，只在最後追加兩個欄位（create or replace view 只能在尾端新增欄位）
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
  p.image_height
from public.product_variants v
join public.products p on p.id = v.product_id
left join public.categories c on c.id = p.category_id;

revoke all on public.storefront_variants from anon, authenticated;
grant select on public.storefront_variants to anon, authenticated;

commit;
