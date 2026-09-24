-- 管理商品建立：舊 overload 移除後只剩 16 參數版 admin_create_product。
-- Worker 以 16 個具名參數呼叫；只給前 13 個位置參數也能無歧義地對應同一個函式（後 3 個有預設值）。

-- 管理員以 Worker 的具名參數建立商品：寫入商品、規格、初始庫存異動與稽核紀錄。
begin;
select tests.seed();
select tests.as_service();
select tests.assert((
  select (r ->> 'product_id') is not null and (r ->> 'variant_id') is not null
  from (select public.admin_create_product(
    p_actor_id => tests.id('admin'), p_category_name => '測試分類', p_product_name => '新商品',
    p_description => '', p_variant_name => '單一規格', p_sku => 'new-sku', p_kind => 'in_stock',
    p_price => 500, p_stock => 3, p_preorder_arrival => null, p_deposit_rate => 0,
    p_seller_link => null, p_is_published => true, p_purchase_limit => null,
    p_points_eligible => true, p_compare_at_price => 600) as r) x
), 'admin creates a product with the Worker''s named parameters');
select tests.logout();
select tests.assert((select stock_on_hand = 3 and compare_at_price = 600 and price = 500 from public.product_variants where sku = 'NEW-SKU'),
                    'variant stored with normalized SKU, price, compare-at price and stock');
select tests.assert((select count(*) = 1 from public.inventory_movements m join public.product_variants v on v.id = m.variant_id
                     where v.sku = 'NEW-SKU' and m.kind = 'stock_in' and m.quantity_delta = 3), 'initial stock is recorded as a movement');
select tests.assert((select count(*) = 2 from public.audit_logs where action = 'create' and resource in ('product', 'product_variant')),
                    'product and variant creation are audited');
rollback;

-- 只給 13 個位置參數時使用預設值（不限購、可積點、無原價），不再有 overload 歧義。
begin;
select tests.seed();
select tests.as_service();
select public.admin_create_product(tests.id('admin'), '測試分類', '簡易商品', '', '單一規格', 'short-sku', 'in_stock', 100, 0, null, 0, null, false);
select tests.logout();
select tests.assert((select p.purchase_limit is null and p.points_eligible and v.compare_at_price is null
                     from public.product_variants v join public.products p on p.id = v.product_id where v.sku = 'SHORT-SKU'),
                    '13 positional arguments resolve to the latest version with its defaults');
rollback;

-- 拒絕：非管理員 actor 由函式擋下；API 角色（即使本人是管理員）不能直接呼叫。
begin;
select tests.seed();
select tests.as_service();
select tests.expect_error($$select public.admin_create_product(tests.id('member_a'), '測試分類', 'X', '', '單一規格', 'x-sku', 'in_stock', 1, 0, null, 0, null, false)$$,
                          'ADMIN_REQUIRED', 'non-admin actor is rejected');
select tests.login(tests.id('admin'));
select tests.expect_error($$select public.admin_create_product(tests.id('admin'), '測試分類', 'X', '', '單一規格', 'x-sku', 'in_stock', 1, 0, null, 0, null, false)$$,
                          'permission denied', 'API roles cannot call it directly, even an admin');
select tests.login(null);
select tests.expect_error($$select public.admin_create_product(tests.id('admin'), '測試分類', 'X', '', '單一規格', 'x-sku', 'in_stock', 1, 0, null, 0, null, false)$$,
                          'permission denied', 'anon cannot call it');
select tests.logout();
select tests.assert((select count(*) = 0 from public.product_variants where sku = 'X-SKU'), 'rejected calls created nothing');
rollback;
