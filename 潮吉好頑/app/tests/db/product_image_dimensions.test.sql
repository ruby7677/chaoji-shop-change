-- 商品主圖寬高：換主圖（路徑或版本改變）且同一次更新沒有寫入寬高時清成 null；只寫寬高或同時寫入時保留；匿名可讀公開型錄的寬高。

begin;
select tests.seed();
update public.products set image_path = 'p/primary.webp', image_updated_at = '2026-10-01', image_width = 800, image_height = 600 where id = tests.id('product_stock');
select tests.assert((select image_width = 800 and image_height = 600 from public.products where id = tests.id('product_stock')),
                    'dimensions written together with a new image are kept');
update public.products set image_updated_at = '2026-10-02' where id = tests.id('product_stock');
select tests.assert((select image_width is null and image_height is null from public.products where id = tests.id('product_stock')),
                    'a new image version clears the old dimensions');
update public.products set image_width = 500, image_height = 700 where id = tests.id('product_stock');
select tests.assert((select image_width = 500 and image_height = 700 from public.products where id = tests.id('product_stock')),
                    'writing only the dimensions keeps them');
update public.products set image_path = 'p/second.webp' where id = tests.id('product_stock');
select tests.assert((select image_width is null from public.products where id = tests.id('product_stock')),
                    'switching the main image path clears the old dimensions');
update public.products set name = name || '（改名）', image_width = 320, image_height = 240 where id = tests.id('product_stock');
update public.products set name = '現貨測試商品' where id = tests.id('product_stock');
select tests.assert((select image_width = 320 from public.products where id = tests.id('product_stock')),
                    'other product edits do not touch the dimensions');
select tests.login(null);
select tests.assert((select bool_and(image_width = 320 and image_height = 240) from public.storefront_variants where product_id = tests.id('product_stock')::text),
                    'anon can read the dimensions through the public catalog');
select tests.logout();
rollback;
