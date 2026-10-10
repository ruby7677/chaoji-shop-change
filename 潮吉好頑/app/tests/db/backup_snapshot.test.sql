-- 每週備份快照 backup_snapshot()：一次讀出所有營運資料表、不含工作階段與暫存表；只有 service_role 能執行。

begin;
select tests.seed();
select tests.login(tests.id('member_a'));
select tests.place_order(tests.id('variant_stock'), 1);
select tests.as_service();
create temp table snap on commit drop as select public.backup_snapshot() as s;
select tests.assert((select s->'tables'->'orders' from snap) is not null and jsonb_array_length((select s->'tables'->'orders' from snap)) = (select count(*) from public.orders), 'orders are all in the snapshot');
select tests.assert(jsonb_array_length((select s->'tables'->'order_items' from snap)) = (select count(*) from public.order_items), 'order items are all in the snapshot');
select tests.assert(jsonb_array_length((select s->'tables'->'profiles' from snap)) = (select count(*) from public.profiles), 'profiles are all in the snapshot');
select tests.assert(not ((select s->'tables' from snap) ?| array['liff_session_vault', 'member_cart_items', 'line_low_stock_states', 'notification_deliveries']), 'session, cart and notification state are excluded');
select tests.assert((select s->'tables'->'coupons' from snap) = '[]'::jsonb or jsonb_typeof((select s->'tables'->'coupons' from snap)) = 'array', 'empty tables are empty arrays, not null');
select tests.assert((select s ? 'taken_at' from snap), 'the snapshot records when it was taken');
rollback;

-- 會員與訪客不能執行（快照含所有會員個資）。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
select tests.expect_error($$select public.backup_snapshot()$$, 'permission denied', 'members cannot take a snapshot');
select tests.login(null);
select tests.expect_error($$select public.backup_snapshot()$$, 'permission denied', 'anon cannot take a snapshot');
rollback;
