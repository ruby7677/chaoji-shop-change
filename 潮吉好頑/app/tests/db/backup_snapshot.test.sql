-- 每週備份快照 backup_snapshot()：一次讀出所有營運資料表、不含工作階段與暫存表；只有 service_role 能執行。

begin;
select tests.seed();
select tests.login(tests.id('member_a'));
select tests.place_order(tests.id('variant_stock'), 1);
select tests.as_service();
create temp table snap on commit drop as select public.backup_snapshot() as s;
select tests.logout(); -- 斷言要讀 auth 與 supabase_migrations，測試環境的 service_role 沒有這些表的權限
select tests.assert((select s->'tables'->'orders' from snap) is not null and jsonb_array_length((select s->'tables'->'orders' from snap)) = (select count(*) from public.orders), 'orders are all in the snapshot');
select tests.assert(jsonb_array_length((select s->'tables'->'order_items' from snap)) = (select count(*) from public.order_items), 'order items are all in the snapshot');
select tests.assert(jsonb_array_length((select s->'tables'->'profiles' from snap)) = (select count(*) from public.profiles), 'profiles are all in the snapshot');
select tests.assert(not ((select s->'tables' from snap) ?| array['liff_session_vault', 'member_cart_items', 'line_low_stock_states', 'notification_deliveries']), 'session, cart and notification state are excluded');
select tests.assert((select s->'tables'->'coupons' from snap) = '[]'::jsonb or jsonb_typeof((select s->'tables'->'coupons' from snap)) = 'array', 'empty tables are empty arrays, not null');
select tests.assert((select s ? 'taken_at' from snap), 'the snapshot records when it was taken');
select tests.assert((select (s->>'format')::int = 2 from snap), 'the snapshot declares its format');
select tests.assert((select s->>'migration_version' from snap) = (select max(version) from supabase_migrations.schema_migrations), 'the snapshot records the schema version it was taken at');
rollback;

-- Auth 身分只帶重建登入對應所需的欄位，不含密碼、email、token 與其他 metadata。
begin;
select tests.seed();
insert into auth.identities(user_id, provider, provider_id, identity_data, email)
values (tests.id('member_a'), 'custom:line-web', 'U' || repeat('b', 32), jsonb_build_object('sub', 'U' || repeat('b', 32), 'email', 'a@example.test', 'picture', 'https://x.test/p.png'), 'a@example.test');
select tests.as_service();
create temp table snap on commit drop as select public.backup_snapshot() as s;
select tests.logout();
create temp table backed_user on commit drop as
  select u from snap, jsonb_array_elements(s->'auth_users') u where u->>'id' = tests.id('member_a')::text;
select tests.assert(jsonb_array_length((select s->'auth_users' from snap)) = (select count(*) from auth.users), 'every auth user is in the snapshot');
select tests.assert((select u->'identities'->0 from backed_user) = jsonb_build_object('provider', 'custom:line-web', 'provider_id', 'U' || repeat('b', 32), 'sub', 'U' || repeat('b', 32), 'created_at', (select created_at from auth.identities where user_id = tests.id('member_a'))), 'the LINE identity keeps only provider, provider_id, sub and created_at');
select tests.assert((select array(select jsonb_object_keys(u) order by 1) from backed_user) = array['created_at', 'id', 'identities'], 'auth users carry only id, created_at and identities');
select tests.assert(position('a@example.test' in (select s::text from snap)) = 0, 'no email reaches the snapshot');
rollback;

-- 會員與訪客不能執行（快照含所有會員個資）。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
select tests.expect_error($$select public.backup_snapshot()$$, 'permission denied', 'members cannot take a snapshot');
select tests.login(null);
select tests.expect_error($$select public.backup_snapshot()$$, 'permission denied', 'anon cannot take a snapshot');
rollback;
