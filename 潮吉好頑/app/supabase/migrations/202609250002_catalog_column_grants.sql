-- 潮吉好頑：公開型錄底層表改為欄位級授權。
-- storefront_variants 是 security_invoker view，anon／authenticated 需要底層表的 SELECT 權限；
-- 202609140001 因此對 categories、products、product_variants 給了整表 SELECT，
-- 任何人都能用公開的 anon key 直接查 /rest/v1/product_variants，讀到成本（cost）、SKU、
-- 安全庫存與實際庫存。改為只授權 view 與 replace_member_cart 用到的欄位；
-- 之後新增的欄位預設不公開，前台 view 需要時必須在這裡補授權（tests/db 會抓到遺漏）。
-- RLS（只看已上架）不變；可售量仍由 private.storefront_available_stock 以擁有者權限計算。

begin;

-- 撤銷整表權限時，PostgreSQL 會一併撤銷既有的欄位級授權，下方重新授權即為完整清單。
revoke all on table public.categories, public.products, public.product_variants from anon, authenticated;

grant select (id, name)
  on table public.categories to anon, authenticated;

grant select (
  id, category_id, name, description, image_path, image_updated_at,
  purchase_limit, points_eligible, hero_rank, hero_tagline, is_published
) on table public.products to anon, authenticated;

grant select (
  id, product_id, name, kind, price, compare_at_price, preorder_arrival,
  seller_link, shipping_units, display_order, is_published
) on table public.product_variants to anon, authenticated;

commit;
