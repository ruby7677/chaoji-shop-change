-- 後台訂單搜尋：可用商品名稱與規格名稱找到訂單；萬用字元當一般文字；非管理員被拒絕。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_stock on commit drop as select tests.place_order(tests.id('variant_stock'), 1) as id;
create temp table t_pre on commit drop as select tests.place_order(tests.id('variant_pre'), 1) as id;
select tests.logout();
update public.order_items set product_name = '鳳凰武力改造組', variant_name = '整盒' where order_id = (select id from t_stock);
update public.order_items set product_name = '火影忍者盲盒', variant_name = '單抽' where order_id = (select id from t_pre);

select tests.assert((select public.admin_search_order_ids(tests.id('admin'), '鳳凰') -> 'ids' = to_jsonb(array[(select id from t_stock)])),
                    'a product name keyword finds only the matching order');
select tests.assert((select public.admin_search_order_ids(tests.id('admin'), '單抽') -> 'ids' = to_jsonb(array[(select id from t_pre)])),
                    'a variant name keyword finds the matching order');
select tests.assert((select jsonb_array_length(public.admin_search_order_ids(tests.id('admin'), '盒') -> 'ids') = 2),
                    'a keyword shared by both products returns both orders');
select tests.assert((select jsonb_array_length(public.admin_search_order_ids(tests.id('admin'), '%') -> 'ids') = 0),
                    'a percent sign is matched literally, not as a wildcard');
select tests.assert((select jsonb_array_length(public.admin_search_order_ids(tests.id('admin'), '鳳凰', 'cancelled') -> 'ids') = 0),
                    'the status filter still applies to product name matches');
select tests.expect_error($$select public.admin_search_order_ids(tests.id('member_a'), '鳳凰')$$, 'ADMIN_REQUIRED', 'a member cannot search orders');
rollback;
