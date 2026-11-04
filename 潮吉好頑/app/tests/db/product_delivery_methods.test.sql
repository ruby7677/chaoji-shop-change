-- 商品可用取貨方式：預設三種全開、建單時不允許的方式被擋（含同單任一商品不允許）、
-- 管理 RPC 驗證與稽核、null 不覆蓋、舊訂單與 API 角色權限不受影響。

-- 預設：既有商品三種全開，三種取貨方式都能建單。
begin;
select tests.seed();
select tests.assert((select allowed_delivery_methods @> array['store_pickup', 'cvs_delivery', 'home_delivery']::text[] and cardinality(allowed_delivery_methods) = 3
                       from public.products where id = tests.id('product_stock')), 'existing products default to all three methods');
select tests.login(tests.id('member_a'));
select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 1), 'together', 'store_pickup', null, 0, tests.id('bank'), null, null, null, null, null, null, null, null);
select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 1), 'together', 'home_delivery', null, 0, tests.id('bank'), null, '台南市中西區民生路二段 93 號', '王小明', '0912345678', null, null, null, null);
select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 1), 'together', 'cvs_delivery', null, 0, tests.id('bank'), null, null,
    '王小明', '0912345678', '臺南市', '中西區', '民生門市', '123456');
select tests.logout();
select tests.assert((select count(*) = 3 from public.orders where member_id = tests.id('member_a')), 'default products accept all three delivery methods');
rollback;

-- 拒絕：商品只允許宅配與到店時，7-11 店到店建單被擋，且沒有留下訂單；允許的方式仍可建單。
begin;
select tests.seed();
update public.products set allowed_delivery_methods = array['store_pickup', 'home_delivery'] where id = tests.id('product_stock');
select tests.login(tests.id('member_a'));
select tests.expect_error($$select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 1), 'together', 'cvs_delivery', null, 0, tests.id('bank'), null, null,
    '王小明', '0912345678', '臺南市', '中西區', '民生門市', '123456')$$, 'DELIVERY_METHOD_NOT_ALLOWED', 'cvs order for a store/home-only product is rejected');
select tests.assert((select count(*) = 0 from public.orders), 'the rejected cvs order left nothing behind');
select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 1), 'together', 'home_delivery', null, 0, tests.id('bank'), null, '台南市中西區民生路二段 93 號', '王小明', '0912345678', null, null, null, null);
select tests.logout();
select tests.assert((select count(*) = 1 from public.orders where member_id = tests.id('member_a')), 'only the allowed home delivery order exists');
rollback;

-- 預購商品同樣受限；僅宅配的商品選到店取貨也被擋。
begin;
select tests.seed();
update public.products set allowed_delivery_methods = array['home_delivery'] where id = tests.id('product_pre');
select tests.login(tests.id('member_a'));
select tests.expect_error($$select public.create_delivery_order(tests.order_items(tests.id('variant_pre'), 1), 'together', 'store_pickup', null, 0, tests.id('bank'), null, null, null, null, null, null, null, null)$$,
                          'DELIVERY_METHOD_NOT_ALLOWED', 'home-only preorder product cannot be picked up in store');
select tests.logout();
select tests.assert((select count(*) = 0 from public.orders), 'no order created for the rejected preorder');
rollback;

-- 同一張訂單有多項商品時，只要其中一項不允許就整張拒絕。
begin;
select tests.seed();
insert into public.products(id, name, category_id, is_published, allowed_delivery_methods)
values ('00000000-0000-4000-8000-0000000000e1', '大型現貨商品', tests.id('category'), true, array['home_delivery']);
insert into public.product_variants(id, product_id, name, sku, kind, price, stock_on_hand, deposit_rate, is_published)
values ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000e1', '單一規格', 'TEST-BIG', 'in_stock', 500, 5, 0, true);
select tests.login(tests.id('member_a'));
select tests.expect_error($$select public.create_delivery_order(jsonb_build_array(
    jsonb_build_object('variant_id', tests.id('variant_stock'), 'quantity', 1),
    jsonb_build_object('variant_id', '00000000-0000-4000-8000-0000000000e2', 'quantity', 1)), 'together', 'store_pickup', null, 0, tests.id('bank'), null, null, null, null, null, null, null, null)$$,
                          'DELIVERY_METHOD_NOT_ALLOWED', 'one restricted item rejects the whole order');
select tests.assert((select count(*) = 0 from public.orders), 'no order created when any item disallows the method');
select public.create_delivery_order(jsonb_build_array(
    jsonb_build_object('variant_id', tests.id('variant_stock'), 'quantity', 1),
    jsonb_build_object('variant_id', '00000000-0000-4000-8000-0000000000e2', 'quantity', 1)), 'together', 'home_delivery', null, 0, tests.id('bank'), null, '台南市中西區民生路二段 93 號', '王小明', '0912345678', null, null, null, null);
select tests.logout();
select tests.assert((select count(*) = 1 from public.orders), 'the shared allowed method still creates the order');
rollback;

-- 管理建立：預設三種全開；指定時去重排序後寫入並進稽核；空陣列、未知值與空元素被拒絕。
begin;
select tests.seed();
select tests.as_service();
select public.admin_create_product(tests.id('admin'), '測試分類', '預設商品', '', '單一規格', 'dm-default', 'in_stock', 100, 0, null, 0, null, false);
select public.admin_create_product(
  p_actor_id => tests.id('admin'), p_category_name => '測試分類', p_product_name => '大型商品', p_description => '', p_variant_name => '單一規格',
  p_sku => 'dm-big', p_kind => 'in_stock', p_price => 100, p_stock => 0, p_preorder_arrival => null, p_deposit_rate => 0, p_seller_link => null,
  p_is_published => false, p_delivery_methods => array['home_delivery', 'store_pickup', 'home_delivery']);
select tests.expect_error($$select public.admin_create_product(tests.id('admin'), '測試分類', '空', '', '單一規格', 'dm-empty', 'in_stock', 1, 0, null, 0, null, false, null, true, null, array[]::text[])$$,
                          'INVALID_DELIVERY_METHODS', 'empty method list is rejected');
select tests.expect_error($$select public.admin_create_product(tests.id('admin'), '測試分類', '未知', '', '單一規格', 'dm-bad', 'in_stock', 1, 0, null, 0, null, false, null, true, null, array['store_pickup', 'seller_delivery'])$$,
                          'INVALID_DELIVERY_METHODS', 'retired or unknown method is rejected');
select tests.expect_error($$select public.admin_create_product(tests.id('admin'), '測試分類', '空值', '', '單一規格', 'dm-null', 'in_stock', 1, 0, null, 0, null, false, null, true, null, array['store_pickup', null])$$,
                          'INVALID_DELIVERY_METHODS', 'null element is rejected');
select tests.logout();
select tests.assert((select cardinality(p.allowed_delivery_methods) = 3 from public.products p join public.product_variants v on v.product_id = p.id where v.sku = 'DM-DEFAULT'), 'unspecified methods default to all three');
select tests.assert((select p.allowed_delivery_methods = array['home_delivery', 'store_pickup']::text[] from public.products p join public.product_variants v on v.product_id = p.id where v.sku = 'DM-BIG'), 'restricted methods are deduplicated and stored');
select tests.assert((select count(*) = 0 from public.product_variants where sku in ('DM-EMPTY', 'DM-BAD', 'DM-NULL')), 'rejected creations leave nothing behind');
select tests.assert((select count(*) = 1 from public.audit_logs where resource = 'product' and action = 'create' and (after_data ->> 'name') = '大型商品'
                       and after_data -> 'allowed_delivery_methods' = '["home_delivery", "store_pickup"]'::jsonb), 'creation audit records the allowed methods');
rollback;

-- 管理編輯：null 不覆蓋、指定值更新並進稽核、無效值被拒、非管理員被擋。
begin;
select tests.seed();
select tests.as_service();
select public.admin_update_product(tests.id('admin'), tests.id('product_stock'), '現貨測試商品', '', null, null, true, true, 0, array['store_pickup', 'home_delivery']);
select tests.assert((select allowed_delivery_methods = array['home_delivery', 'store_pickup']::text[] from public.products where id = tests.id('product_stock')), 'update stores the normalized methods');
select public.admin_update_product(tests.id('admin'), tests.id('product_stock'), '現貨測試商品', '', null, null, true, true, 0);
select tests.assert((select allowed_delivery_methods = array['home_delivery', 'store_pickup']::text[] from public.products where id = tests.id('product_stock')), 'omitting the methods keeps the current setting');
select tests.expect_error($$select public.admin_update_product(tests.id('admin'), tests.id('product_stock'), '現貨測試商品', '', null, null, true, true, 0, array['bogus'])$$,
                          'INVALID_DELIVERY_METHODS', 'unknown method is rejected on update');
select tests.expect_error($$select public.admin_update_product(tests.id('member_a'), tests.id('product_stock'), '現貨測試商品', '', null, null, true, true, 0, array['store_pickup'])$$,
                          'ADMIN_REQUIRED', 'non-admin actor cannot change methods');
select tests.assert((select count(*) >= 1 from public.audit_logs where resource = 'product' and action = 'update'
                       and after_data -> 'allowed_delivery_methods' = '["home_delivery", "store_pickup"]'::jsonb), 'update audit records the allowed methods');
select tests.logout();
rollback;

-- 資料表約束：直接寫入空陣列或未知值被資料庫擋下。
begin;
select tests.seed();
select tests.expect_error($$update public.products set allowed_delivery_methods = array[]::text[] where id = tests.id('product_stock')$$, 'products_allowed_delivery_methods_check', 'table rejects an empty list');
select tests.expect_error($$update public.products set allowed_delivery_methods = array['seller_delivery'] where id = tests.id('product_stock')$$, 'products_allowed_delivery_methods_check', 'table rejects an unknown method');
rollback;

-- 權限：匿名與一般會員可讀到型錄欄位，但不能直接改商品或呼叫管理 RPC。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
select tests.assert((select allowed_delivery_methods is not null from public.storefront_variants where id = tests.id('variant_stock')::text), 'members read the methods through storefront_variants');
select tests.expect_error($$update public.products set allowed_delivery_methods = array['store_pickup'] where id = tests.id('product_stock')$$, 'permission denied', 'members cannot update products directly');
select tests.expect_error($$select public.admin_update_product(tests.id('admin'), tests.id('product_stock'), 'x', '', null, null, true, true, 0, array['store_pickup'])$$, 'permission denied', 'API roles cannot call admin_update_product');
select tests.login(null);
select tests.assert((select allowed_delivery_methods is not null from public.storefront_variants where id = tests.id('variant_stock')::text), 'anon reads the methods through storefront_variants');
select tests.logout();
rollback;
