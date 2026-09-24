-- 低庫存唯一定義 low_stock_variants：商品與規格都上架中，且實際庫存 ≤ 安全庫存；後台統計與清單共用同一結果。

begin;
select tests.seed();
-- 上架中且低於門檻；等於門檻也算低庫存。
update public.product_variants set stock_on_hand = 1 where id = tests.id('variant_stock');
update public.product_variants set stock_on_hand = 3, safety_stock = 3 where id = tests.id('variant_pre');
-- 規格下架、商品下架：即使缺貨也不算。
insert into public.product_variants(id, product_id, name, sku, kind, price, stock_on_hand, safety_stock, deposit_rate, is_published) values
  ('00000000-0000-4000-8000-0000000000b3', tests.id('product_stock'), '下架規格', 'TEST-HIDDEN', 'in_stock', 100, 0, 3, 0, false);
insert into public.products(id, name, category_id, is_published) values ('00000000-0000-4000-8000-0000000000a3', '下架商品', tests.id('category'), false);
insert into public.product_variants(id, product_id, name, sku, kind, price, stock_on_hand, safety_stock, deposit_rate, is_published) values
  ('00000000-0000-4000-8000-0000000000b4', '00000000-0000-4000-8000-0000000000a3', '單一規格', 'TEST-HIDDEN-PRODUCT', 'in_stock', 100, 0, 3, 0, true);
select tests.as_service();
select tests.assert((select array_agg(sku order by stock_on_hand) = array['TEST-STOCK', 'TEST-PRE'] from public.low_stock_variants()),
                    'only published variants of published products at or below safety stock, lowest first');
select tests.assert((select product_name = '現貨測試商品' and stock_on_hand = 1 and safety_stock = 3 from public.low_stock_variants() where sku = 'TEST-STOCK'),
                    'rows carry the product name and stock levels');
select tests.assert((select count(*) = 1 from public.low_stock_variants(1)), 'the limit caps the list');
select tests.assert((public.admin_dashboard_stats(tests.id('admin'))->>'lowStock')::int = 2, 'the dashboard count uses the same definition');
select tests.login(tests.id('member_a'));
select tests.expect_error($$select * from public.low_stock_variants()$$, 'permission denied', 'members cannot list low stock');
select tests.login(null);
select tests.expect_error($$select * from public.low_stock_variants()$$, 'permission denied', 'anon cannot list low stock');
rollback;
