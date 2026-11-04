-- 前台顯示庫存（product_variants.show_stock）：建立時依類型預設（現貨不顯示、預購顯示）、可明確指定、
-- 編輯時 null 不覆蓋、前台 view 讀得到且 anon 只多了這一個欄位的授權。

-- 新增商品：不指定時現貨不顯示、預購顯示；明確指定時照用。
begin;
select tests.seed();
-- 同一個 statement 看不到函式內新增的列，先建立再以商品名稱查詢
select public.admin_create_product(tests.id('admin'), '測試分類', '現貨預設', '', '單一規格', null, 'in_stock', 100, 3, null, 0, null, true);
select public.admin_create_product(tests.id('admin'), '測試分類', '預購預設', '', '單一規格', null, 'preorder', 100, 3, null, 0.5, null, true);
select public.admin_create_product(tests.id('admin'), '測試分類', '現貨顯示', '', '單一規格', null, 'in_stock', 100, 3, null, 0, null, true, null, true, null, null, true);
select tests.assert((select not v.show_stock from public.product_variants v join public.products p on p.id = v.product_id where p.name = '現貨預設'),
                    'in-stock product hides stock by default');
select tests.assert((select v.show_stock from public.product_variants v join public.products p on p.id = v.product_id where p.name = '預購預設'),
                    'preorder product shows stock by default');
select tests.assert((select v.show_stock from public.product_variants v join public.products p on p.id = v.product_id where p.name = '現貨顯示'),
                    'explicit p_show_stock overrides the in-stock default');
rollback;

-- 新增規格：同樣依類型預設，可明確指定。
begin;
select tests.seed();
select tests.assert((public.admin_create_variant(tests.id('admin'), tests.id('product_stock'), '現貨規格', null, 'in_stock', 100, null, 3, null, 0, null, true, null, 2)->>'show_stock')::boolean = false,
                    'new in-stock variant hides stock by default');
select tests.assert((public.admin_create_variant(tests.id('admin'), tests.id('product_pre'), '預購規格', null, 'preorder', 100, null, 3, null, 0.5, null, true, null, 2)->>'show_stock')::boolean,
                    'new preorder variant shows stock by default');
select tests.assert((public.admin_create_variant(tests.id('admin'), tests.id('product_pre'), '預購隱藏', null, 'preorder', 100, null, 3, null, 0.5, null, true, null, 2, false)->>'show_stock')::boolean = false,
                    'explicit p_show_stock overrides the preorder default');
rollback;

-- 編輯規格：明確值寫入並記入稽核；null（舊 Worker 不帶參數）保留原值。
begin;
select tests.seed();
select public.admin_update_variant(tests.id('admin'), tests.id('variant_stock'), '單一規格', 'TEST-STOCK', 'in_stock', 1000, null, true, 3, null, 0, null, true, null, true);
select tests.assert((select show_stock from public.product_variants where id = tests.id('variant_stock')), 'update writes show_stock');
select tests.assert((select (after_data->>'show_stock')::boolean from public.audit_logs
                      where resource = 'product_variant' and target = tests.id('variant_stock')::text order by created_at desc, id desc limit 1),
                    'audit log records the new show_stock');
select public.admin_update_variant(tests.id('admin'), tests.id('variant_stock'), '單一規格', 'TEST-STOCK', 'in_stock', 900, null, true, 3, null, 0, null, true, null);
select tests.assert((select show_stock and price = 900 from public.product_variants where id = tests.id('variant_stock')), 'update without p_show_stock keeps the value');
rollback;

-- 前台：storefront_variants 帶出 show_stock；anon 可讀這個欄位，仍讀不到實體庫存與成本欄位。
begin;
select tests.seed();
update public.product_variants set show_stock = true where id = tests.id('variant_pre');
select tests.login(null);
select tests.assert((select show_stock from public.storefront_variants where id = tests.id('variant_pre')::text), 'anon reads show_stock from the storefront view');
select tests.logout();
select tests.assert(has_column_privilege('anon', 'public.product_variants', 'show_stock', 'SELECT'), 'anon has SELECT on show_stock');
select tests.assert(not has_column_privilege('anon', 'public.product_variants', 'stock_on_hand', 'SELECT'), 'anon still cannot read stock_on_hand');
rollback;
