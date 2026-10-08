-- 新增規格的安全庫存（低庫存警示門檻）預設由 3 改為 0（業主 2026-10-08 決定）：只有售完才列入低庫存提醒。
-- 後台「新增商品」建立第一個規格時沒有帶安全庫存，使用的是這個欄位預設值；
-- 其他規格表單與 API 已由前端／Worker 帶入 0。既有規格的安全庫存不變。
alter table public.product_variants alter column safety_stock set default 0;
