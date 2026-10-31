-- 規格圖片（product_variants.image_id）：只能指定同一商品的多圖、可清除、未帶旗標不變、
-- 刪除圖片只清空指定；前台 view 讀得到且 anon 只多了這一個欄位的授權。

-- 指定、未帶旗標保留、清除，並記入稽核。
begin;
select tests.seed();
insert into public.product_images(id, product_id, storage_path, sort_order)
values ('00000000-0000-4000-8000-0000000000e1'::uuid, tests.id('product_stock'), 'test/stock-a.webp', 0);
select public.admin_update_variant(tests.id('admin'), tests.id('variant_stock'), '單一規格', 'TEST-STOCK', 'in_stock', 1000, null, true, 3, null, 0, null, true, null, null, '00000000-0000-4000-8000-0000000000e1'::uuid, true);
select tests.assert((select image_id = '00000000-0000-4000-8000-0000000000e1'::uuid from public.product_variants where id = tests.id('variant_stock')), 'admin assigns an image of the same product');
select tests.assert((select after_data->>'image_id' = '00000000-0000-4000-8000-0000000000e1'::uuid::text from public.audit_logs
                      where resource = 'product_variant' and target = tests.id('variant_stock')::text order by created_at desc, id desc limit 1),
                    'audit log records the new image_id');
select public.admin_update_variant(tests.id('admin'), tests.id('variant_stock'), '單一規格', 'TEST-STOCK', 'in_stock', 900, null, true, 3, null, 0, null, true, null);
select tests.assert((select image_id = '00000000-0000-4000-8000-0000000000e1'::uuid and price = 900 from public.product_variants where id = tests.id('variant_stock')),
                    'update without p_update_image keeps the image');
select public.admin_update_variant(tests.id('admin'), tests.id('variant_stock'), '單一規格', 'TEST-STOCK', 'in_stock', 900, null, true, 3, null, 0, null, true, null, null, null, true);
select tests.assert((select image_id is null from public.product_variants where id = tests.id('variant_stock')), 'p_update_image with null clears the image');
rollback;

-- 拒絕：其他商品的圖片、非管理員。
begin;
select tests.seed();
insert into public.product_images(id, product_id, storage_path, sort_order)
values ('00000000-0000-4000-8000-0000000000e2'::uuid, tests.id('product_pre'), 'test/pre-a.webp', 0);
select tests.expect_error(
  $$select public.admin_update_variant(tests.id('admin'), tests.id('variant_stock'), '單一規格', 'TEST-STOCK', 'in_stock', 1000, null, true, 3, null, 0, null, true, null, null, '00000000-0000-4000-8000-0000000000e2'::uuid, true)$$,
  'INVALID_VARIANT_IMAGE', 'an image of another product is rejected');
select tests.expect_error(
  $$update public.product_variants set image_id = '00000000-0000-4000-8000-0000000000e2'::uuid where id = tests.id('variant_stock')$$,
  'product_variants_image_fkey', 'the foreign key rejects a cross-product image even outside the RPC');
select tests.expect_error(
  $$select public.admin_update_variant(tests.id('member_a'), tests.id('variant_pre'), '單一規格', 'TEST-PRE', 'preorder', 2000, null, true, 3, null, 0.5, null, true, null, null, '00000000-0000-4000-8000-0000000000e2'::uuid, true)$$,
  'ADMIN_REQUIRED', 'non-admin cannot assign a variant image');
rollback;

-- 刪除圖片：規格保留、只清空 image_id。
begin;
select tests.seed();
insert into public.product_images(id, product_id, storage_path, sort_order)
values ('00000000-0000-4000-8000-0000000000e2'::uuid, tests.id('product_pre'), 'test/pre-a.webp', 0);
update public.product_variants set image_id = '00000000-0000-4000-8000-0000000000e2'::uuid where id = tests.id('variant_pre');
delete from public.product_images where id = '00000000-0000-4000-8000-0000000000e2'::uuid;
select tests.assert((select image_id is null and product_id = tests.id('product_pre') from public.product_variants where id = tests.id('variant_pre')),
                    'deleting the image clears image_id and keeps the variant');
rollback;

-- 前台：storefront_variants 帶出 image_id；anon 可讀這個欄位。
begin;
select tests.seed();
insert into public.product_images(id, product_id, storage_path, sort_order)
values ('00000000-0000-4000-8000-0000000000e2'::uuid, tests.id('product_pre'), 'test/pre-a.webp', 0);
update public.product_variants set image_id = '00000000-0000-4000-8000-0000000000e2'::uuid where id = tests.id('variant_pre');
select tests.login(null);
select tests.assert((select image_id = '00000000-0000-4000-8000-0000000000e2'::uuid::text from public.storefront_variants where id = tests.id('variant_pre')::text),
                    'anon reads image_id from the storefront view');
select tests.logout();
select tests.assert(has_column_privilege('anon', 'public.product_variants', 'image_id', 'SELECT'), 'anon has SELECT on image_id');
rollback;
