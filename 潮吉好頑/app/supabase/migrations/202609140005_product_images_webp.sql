-- 潮吉好頑：商品主圖新上傳統一使用 WebP。
-- 前端會先保留比例、縮放及轉檔；既有 JPG／PNG 物件不在 SQL 中強制轉換。
-- 可重複執行。

begin;

update storage.buckets
set allowed_mime_types = array['image/webp']::text[]
where id = 'product-images';

commit;
