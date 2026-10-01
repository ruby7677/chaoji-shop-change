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

-- 前台排序自動填數（數字越大越前面）：新商品、新規格未指定時取全站最大值 + 1，數字依序遞增不重複；指定值照用。
-- seed 的兩個規格排序都是 0，所以第一個新品是 1。
begin;
select tests.seed();
select tests.as_service();
select public.admin_create_product(tests.id('admin'), '測試分類', '新品一', '', '單一規格', 'order-new-1', 'in_stock', 100, 0, null, 0, null, true);
select public.admin_create_product(tests.id('admin'), '測試分類', '新品二', '', '單一規格', 'order-new-2', 'in_stock', 100, 0, null, 0, null, true);
select public.admin_create_variant(tests.id('admin'), tests.id('product_stock'), '第二款', 'order-auto', 'in_stock', 100, null, 3, null, 0, null, true, null);
select public.admin_create_variant(tests.id('admin'), tests.id('product_stock'), '指定款', 'order-fixed', 'in_stock', 100, null, 3, null, 0, null, true, 50);
select public.admin_create_product(tests.id('admin'), '測試分類', '新品三', '', '單一規格', 'order-new-3', 'in_stock', 100, 0, null, 0, null, false);
select tests.logout();
select tests.assert((select display_order = 1 from public.product_variants where sku = 'ORDER-NEW-1'),
                    'first new product gets the current maximum + 1');
select tests.assert((select display_order = 2 from public.product_variants where sku = 'ORDER-NEW-2'),
                    'next new product counts up by one');
select tests.assert((select display_order = 3 from public.product_variants where sku = 'ORDER-AUTO'),
                    'a new variant without an order also takes the maximum + 1');
select tests.assert((select display_order = 50 from public.product_variants where sku = 'ORDER-FIXED'),
                    'an explicit variant order is kept');
select tests.assert((select display_order = 51 from public.product_variants where sku = 'ORDER-NEW-3'),
                    'the maximum includes unpublished and manually set variants, so numbers never collide');
select tests.assert((select count(*) = count(distinct display_order) from public.product_variants where sku like 'ORDER-%'),
                    'auto-assigned orders are unique');
select tests.assert((select s.id = (select v.id::text from public.product_variants v where v.sku = 'ORDER-FIXED')
                     from public.storefront_variants s where s.is_published order by s.display_order desc, s.id desc limit 1),
                    'the largest order is first on the storefront');
rollback;

-- 規格排序可手動改成負數；未提供排序時保留原值。
begin;
select tests.seed();
select tests.as_service();
select public.admin_update_variant(tests.id('admin'), tests.id('variant_stock'), '單一規格', 'TEST-STOCK', 'in_stock', 1000, null, false, 3, null, 0, null, true, -5);
select tests.logout();
select tests.assert((select display_order = -5 from public.product_variants where id = tests.id('variant_stock')), 'negative order can be saved');
select tests.as_service();
select public.admin_update_variant(tests.id('admin'), tests.id('variant_stock'), '單一規格', 'TEST-STOCK', 'in_stock', 1000, null, false, 3, null, 0, null, true, null);
select tests.logout();
select tests.assert((select display_order = -5 from public.product_variants where id = tests.id('variant_stock')), 'missing order keeps the current value');
rollback;

-- 拒絕：非管理員不能新增或修改規格排序，API 角色不能直接呼叫。
begin;
select tests.seed();
select tests.as_service();
select tests.expect_error($$select public.admin_create_variant(tests.id('member_a'), tests.id('product_stock'), 'X', 'order-deny', 'in_stock', 1, null, 3, null, 0, null, true, null)$$,
                          'ADMIN_REQUIRED', 'non-admin actor cannot create a variant');
select tests.expect_error($$select public.admin_update_variant(tests.id('member_a'), tests.id('variant_stock'), '單一規格', 'TEST-STOCK', 'in_stock', 1000, null, false, 3, null, 0, null, true, -99)$$,
                          'ADMIN_REQUIRED', 'non-admin actor cannot reorder a variant');
select tests.login(tests.id('admin'));
select tests.expect_error($$select public.admin_update_variant(tests.id('admin'), tests.id('variant_stock'), '單一規格', 'TEST-STOCK', 'in_stock', 1000, null, false, 3, null, 0, null, true, -99)$$,
                          'permission denied', 'API roles cannot call admin_update_variant directly');
select tests.logout();
select tests.assert((select display_order = 0 from public.product_variants where id = tests.id('variant_stock')), 'rejected reorder changed nothing');
rollback;

-- 重新上架並排到最前面：取全站最大值 + 1；已是唯一最大值不變；非管理員與 API 角色被拒。
begin;
select tests.seed();
select tests.as_service();
update public.product_variants set display_order = 7 where id = tests.id('variant_pre');
select public.admin_move_variant_to_top(tests.id('admin'), tests.id('variant_stock'));
select tests.logout();
select tests.assert((select display_order = 8 from public.product_variants where id = tests.id('variant_stock')), 'moved variant takes the maximum + 1');
select tests.as_service();
select public.admin_move_variant_to_top(tests.id('admin'), tests.id('variant_stock'));
select tests.logout();
select tests.assert((select display_order = 8 from public.product_variants where id = tests.id('variant_stock')), 'a variant already on top keeps its number');
select tests.assert((select count(*) = 1 from public.audit_logs where resource = 'product_variant' and target = tests.id('variant_stock')::text), 'only the real move is audited');
rollback;

begin;
select tests.seed();
select tests.as_service();
select tests.expect_error($$select public.admin_move_variant_to_top(tests.id('member_a'), tests.id('variant_stock'))$$, 'ADMIN_REQUIRED', 'non-admin actor cannot move a variant');
select tests.login(tests.id('admin'));
select tests.expect_error($$select public.admin_move_variant_to_top(tests.id('admin'), tests.id('variant_stock'))$$, 'permission denied', 'API roles cannot call admin_move_variant_to_top directly');
select tests.logout();
select tests.assert((select display_order = 0 from public.product_variants where id = tests.id('variant_stock')), 'rejected moves changed nothing');
rollback;

-- SKU 為內部欄位：沒給就自動產生（唯一、大寫）、修改時沒給保留原值；同商品規格名稱不可重複（不分大小寫與前後空白）。
begin;
select tests.seed();
select tests.as_service();
select public.admin_create_product(tests.id('admin'), '測試分類', '無SKU商品', '', '單一規格', null, 'in_stock', 100, 0, null, 0, null, true);
select public.admin_create_product(tests.id('admin'), '測試分類', '空白SKU商品', '', '單一規格', '   ', 'in_stock', 100, 0, null, 0, null, true);
select public.admin_create_variant(tests.id('admin'), tests.id('product_stock'), '第二款', null, 'in_stock', 100, null, 3, null, 0, null, true, null);
select tests.logout();
select tests.assert((select count(*) = 3 and count(distinct sku) = 3 and bool_and(sku ~ '^V-[0-9A-F]{10}$')
                     from public.product_variants where name = '第二款' or product_id in (select id from public.products where name in ('無SKU商品', '空白SKU商品'))),
                    'blank or missing SKU is generated as a unique internal code');
select tests.as_service();
select public.admin_update_variant(tests.id('admin'), tests.id('variant_stock'), '改名規格', null, 'in_stock', 1000, null, false, 3, null, 0, null, true, null);
select tests.logout();
select tests.assert((select sku = 'TEST-STOCK' and name = '改名規格' from public.product_variants where id = tests.id('variant_stock')), 'update without SKU keeps the existing one');
rollback;

begin;
select tests.seed();
select tests.as_service();
select tests.expect_error($$select public.admin_create_variant(tests.id('admin'), tests.id('product_stock'), '  單一規格 ', null, 'in_stock', 100, null, 3, null, 0, null, true, null)$$,
                          'VARIANT_NAME_EXISTS', 'same variant name in one product is rejected, ignoring case and spaces');
select public.admin_create_variant(tests.id('admin'), tests.id('product_pre'), '單一規格', null, 'in_stock', 100, null, 3, null, 0, null, true, null) is not null as ok;
select public.admin_create_variant(tests.id('admin'), tests.id('product_stock'), '另一款', null, 'in_stock', 100, null, 3, null, 0, null, true, null);
select tests.expect_error($$select public.admin_update_variant(tests.id('admin'), (select id from public.product_variants where name = '另一款'), '單一規格', null, 'in_stock', 100, null, false, 3, null, 0, null, true, null)$$,
                          'VARIANT_NAME_EXISTS', 'renaming into an existing name is rejected');
select tests.expect_error($$select public.admin_create_variant(tests.id('admin'), tests.id('product_stock'), '手填SKU', 'test-stock', 'in_stock', 100, null, 3, null, 0, null, true, null)$$,
                          'SKU_EXISTS', 'a manually duplicated SKU is still rejected');
select tests.logout();
select tests.assert((select count(*) = 1 from public.product_variants where product_id = tests.id('product_pre') and name = '單一規格'), 'the same name in another product is allowed');
rollback;
