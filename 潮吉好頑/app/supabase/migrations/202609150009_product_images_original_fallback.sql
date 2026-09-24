-- 潮吉好頑：瀏覽器不支援 WebP 轉檔時，允許保留經 Worker 驗證的原始 JPG／PNG。
-- Worker 仍限制圖片 MIME、檔案簽名與單檔 5MB；bucket 維持私有。

begin;

update storage.buckets
set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']::text[]
where id = 'product-images';

commit;
