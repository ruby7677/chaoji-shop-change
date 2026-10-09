-- 公開型錄提供主圖路徑：匿名可透過 storefront_variants 讀到已上架商品的 image_path，讀不到未上架商品。

begin;
select tests.seed();
update public.products set image_path = 'p/abc.webp', image_updated_at = '2026-10-09' where id = tests.id('product_stock');
select tests.login(null);
select tests.assert((select bool_and(image_path = 'p/abc.webp') from public.storefront_variants where product_id = tests.id('product_stock')::text),
                    'anon can read the main image path of a published product');
select tests.logout();
update public.products set is_published = false where id = tests.id('product_stock');
select tests.login(null);
select tests.assert((select count(*) = 0 from public.storefront_variants where product_id = tests.id('product_stock')::text),
                    'unpublished products and their image paths stay hidden from anon');
select tests.logout();
rollback;
