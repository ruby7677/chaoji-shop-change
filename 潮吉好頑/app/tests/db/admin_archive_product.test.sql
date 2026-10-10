-- 後台刪除商品（封存）：有未完成訂單時拒絕；刪除後下架、清購物車、從後台列表與選單隱藏，訂單與稽核保留；只有管理員能刪。

begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select tests.place_order(tests.id('variant_stock'), 1) as id;
select tests.logout();
insert into public.member_cart_items(member_id, variant_id, quantity) values (tests.id('member_b'), tests.id('variant_stock'), 2);
select tests.as_service();
select tests.expect_error(format($$select public.admin_archive_product(%L, %L)$$, tests.id('admin'), tests.id('product_stock')),
  'PRODUCT_HAS_OPEN_ORDERS', 'a product with an unfinished order cannot be deleted');

select tests.logout();
update public.orders set status = 'cancelled' where id = (select id from t_order);
select tests.as_service();
select public.admin_archive_product(tests.id('admin'), tests.id('product_stock'));
select tests.logout();
select tests.assert((select archived_at is not null and not is_published from public.products where id = tests.id('product_stock')), 'the product is archived and unpublished');
select tests.assert(not exists (select 1 from public.product_variants where product_id = tests.id('product_stock') and is_published), 'all its variants are unpublished');
select tests.assert(not exists (select 1 from public.member_cart_items where variant_id = tests.id('variant_stock')), 'member carts no longer hold it');
select tests.assert(exists (select 1 from public.order_items where order_id = (select id from t_order)), 'past order items are kept');
select tests.assert(exists (select 1 from public.audit_logs where action = 'delete' and resource = 'product' and target = tests.id('product_stock')::text), 'the deletion is audited');
select tests.assert(not (public.admin_search_product_ids(tests.id('admin'))->'ids' ? tests.id('product_stock')::text), 'the admin product list hides it');
select tests.assert(not exists (select 1 from jsonb_array_elements(public.admin_management_options(tests.id('admin'))->'products') p where p->>'id' = tests.id('product_stock')::text), 'admin form options hide it');
select tests.assert(public.admin_search_product_ids(tests.id('admin'))->'ids' ? tests.id('product_pre')::text, 'other products stay listed');
select tests.as_service();
select tests.expect_error(format($$select public.admin_archive_product(%L, %L)$$, tests.id('admin'), tests.id('product_stock')),
  'PRODUCT_NOT_FOUND', 'an archived product cannot be deleted twice');
select tests.login(tests.id('member_a'));
select tests.expect_error(format($$select tests.place_order(%L, 1)$$, tests.id('variant_stock')), '', 'a deleted product can no longer be ordered');
rollback;

-- 只有管理員能刪：會員直接呼叫沒有權限；Worker 以非管理員身分呼叫被拒。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
select tests.expect_error(format($$select public.admin_archive_product(%L, %L)$$, tests.id('member_a'), tests.id('product_pre')),
  'permission denied', 'members cannot call it');
select tests.as_service();
select tests.expect_error(format($$select public.admin_archive_product(%L, %L)$$, tests.id('member_a'), tests.id('product_pre')),
  'ADMIN_REQUIRED', 'a non-admin actor is rejected');
select tests.logout();
select tests.assert((select archived_at is null from public.products where id = tests.id('product_pre')), 'the product is untouched');
rollback;

-- 刪除後的防護（202610100003）：不能重新上架、不能放進購物車；仍綁在優惠券上的已刪除商品留在優惠券選單並標記。
begin;
select tests.seed();
insert into public.coupons(id, code, name, discount_amount, valid_from, valid_until)
values ('00000000-0000-4000-8000-0000000000c9', 'ONLYPRE', '預購限定券', 100, now() - interval '1 day', now() + interval '10 days');
insert into public.coupon_products(coupon_id, product_id) values ('00000000-0000-4000-8000-0000000000c9', tests.id('product_pre'));
select tests.as_service();
select public.admin_archive_product(tests.id('admin'), tests.id('product_stock'));
select public.admin_archive_product(tests.id('admin'), tests.id('product_pre'));
select tests.logout();
select tests.expect_error(format($$update public.products set is_published = true where id = %L$$, tests.id('product_stock')), 'PRODUCT_ARCHIVED', 'an archived product cannot be republished');
select tests.expect_error(format($$update public.product_variants set is_published = true where id = %L$$, tests.id('variant_stock')), 'PRODUCT_ARCHIVED', 'variants of an archived product cannot be republished');
select tests.as_service();
select tests.expect_error(format($$select public.admin_update_product(%L, %L, '現貨測試商品', '', null, null, null, true, 0)$$, tests.id('admin'), tests.id('product_stock')), 'PRODUCT_ARCHIVED', 'the admin save RPC cannot republish it either');
select tests.logout();
update public.products set archived_at = null, is_published = true where id = tests.id('product_stock');
select tests.assert((select is_published from public.products where id = tests.id('product_stock')), 'restoring by clearing archived_at allows publishing again');
select tests.login(tests.id('member_a'));
select tests.expect_error(format($$insert into public.member_cart_items(member_id, variant_id, quantity) values (%L, %L, 1)$$, tests.id('member_a'), tests.id('variant_pre')), 'CART_PRODUCT_NOT_FOUND', 'a deleted product cannot be put in a cart');
select tests.expect_error(format($$select public.replace_member_cart(jsonb_build_array(jsonb_build_object('variant_id', %L, 'quantity', 1)))$$, tests.id('variant_pre')), 'CART_PRODUCT_NOT_FOUND', 'cart sync rejects it');
select tests.logout();
select tests.assert((select jsonb_agg(p->'archived') from jsonb_array_elements(public.admin_management_options(tests.id('admin'))->'products') p where p->>'id' = tests.id('product_pre')::text) = '[true]'::jsonb, 'a deleted product still tied to a coupon stays in the options, marked archived');
rollback;
