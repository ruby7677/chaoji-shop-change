-- 後台商品篩選在資料庫做、篩完再分頁：分類、類型、上架狀態（以規格判斷）、限時優惠，以及錯誤參數與非管理員拒絕。

begin;
select tests.seed();

create function pg_temp.ids(p_status text, p_kind text default 'all', p_category text default 'all', p_page_size integer default 100, p_page integer default 0)
returns uuid[] language sql as $$
  select coalesce(array(select jsonb_array_elements_text(public.admin_search_product_ids(tests.id('admin'), '', p_status, p_page, p_page_size, p_category, p_kind)->'ids')::uuid), '{}')
$$;

-- 現貨商品的規格下架（商品本身仍上架）、預購商品設定限時優惠，另建一個沒有分類、沒有規格的商品
update public.product_variants set is_published = false where id = tests.id('variant_stock');
update public.product_variants set compare_at_price = 2500 where id = tests.id('variant_pre');
insert into public.products(id, name, is_published) values (tests.id('product_empty'), '沒有規格的商品', false);

select tests.assert(pg_temp.ids('unpublished') = array[tests.id('product_stock')],
                    'a published product with an unpublished variant counts as unpublished; products without variants are left out');
select tests.assert(pg_temp.ids('published') = array[tests.id('product_pre')], 'published means product and variant are both on sale');
select tests.assert(pg_temp.ids('sale') = array[tests.id('product_pre')], 'sale means compare-at price above the price');
select tests.assert(pg_temp.ids('all', 'preorder') = array[tests.id('product_pre')], 'kind filter');
select tests.assert(cardinality(pg_temp.ids('unpublished', 'preorder')) = 0, 'kind and status must match the same variant');
select tests.assert(tests.id('product_empty') = any(pg_temp.ids('all')), 'with no filters products without variants are listed');
select tests.assert(pg_temp.ids('all', 'all', 'none') = array[tests.id('product_empty')], 'none lists products without a category');
select tests.assert(not (tests.id('product_empty') = any(pg_temp.ids('all', 'all', tests.id('category')::text))), 'category filter');

-- 篩選在分頁之前：每頁 1 件時，第 1 頁就是符合條件的商品
select tests.assert(pg_temp.ids('unpublished', 'all', 'all', 1) = array[tests.id('product_stock')], 'the first page already holds the filtered product');
select tests.assert((public.admin_search_product_ids(tests.id('admin'), '', 'all', 0, 1, 'all', 'all')->'pagination'->>'hasMore')::boolean, 'paging still reports more rows');

select tests.expect_error($$select public.admin_search_product_ids(tests.id('admin'), '', 'bogus', 0, 10, 'all', 'all')$$, 'INVALID_ADMIN_PRODUCT_FILTER', 'unknown status is rejected');
select tests.expect_error($$select public.admin_search_product_ids(tests.id('admin'), '', 'all', 0, 10, 'all', 'used')$$, 'INVALID_ADMIN_PRODUCT_FILTER', 'unknown kind is rejected');
select tests.expect_error($$select public.admin_search_product_ids(tests.id('admin'), '', 'all', 0, 10, 'not-a-uuid', 'all')$$, 'INVALID_ADMIN_PRODUCT_FILTER', 'malformed category is rejected');
select tests.expect_error($$select public.admin_search_product_ids(tests.id('member_a'), '', 'all', 0, 10, 'all', 'all')$$, 'ADMIN_REQUIRED', 'members cannot search the admin product list');
-- 舊版 Worker 只帶 5 個具名參數，仍可呼叫
select tests.assert(jsonb_typeof(public.admin_search_product_ids(p_actor_id => tests.id('admin'), p_query => '', p_status => 'all', p_page => 0, p_page_size => 10)->'ids') = 'array', 'the old five-argument call still works');
rollback;
