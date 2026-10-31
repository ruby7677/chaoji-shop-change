-- 後台訂單分類（private.admin_order_stage 經 admin_search_order_ids／admin_dashboard_stats）：
-- 預購交貨便走完 待付訂→待訂金對帳→待到貨→已通知待尾款確認（回報末五碼後仍在此，徽章計入）→待出貨→已完成；現貨、到店取貨預購、取消各歸對的分類；
-- 舊的狀態篩選值仍可用；非管理員與未知分類一律拒絕。

create or replace function pg_temp.in_stage(p_order uuid, p_stage text) returns boolean
language sql as $$
  select (public.admin_search_order_ids(tests.id('admin'), '', p_stage, 0, 100) -> 'ids') ? p_order::text
$$;

-- 預購交貨便：每一步只出現在一個分類。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select public.create_delivery_order(
    tests.order_items(tests.id('variant_pre'), 1), 'together', 'cvs_delivery', null, 0, tests.id('bank'), null, null,
    '王小明', '0912345678', '臺南市', '中西區', '民生門市', '123456') as id;
grant select on t_order to public;
select tests.logout();
select tests.assert(pg_temp.in_stage((select id from t_order), 'pending_payment'), 'a new order waits for the deposit');
select tests.login(tests.id('member_a'));
select public.submit_order_payment((select id from t_order), tests.id('bank'), '12345');
select tests.logout();
select tests.assert(pg_temp.in_stage((select id from t_order), 'pending_review'), 'a reported deposit waits for reconciliation');
select tests.as_service();
select tests.transition((select id from t_order), 'confirmed');
select tests.logout();
select tests.assert(pg_temp.in_stage((select id from t_order), 'awaiting_arrival') and not pg_temp.in_stage((select id from t_order), 'ready_to_ship'),
                    'a confirmed preorder waits for arrival');
select tests.as_service();
select tests.transition((select id from t_order), 'ready_for_pickup');
select tests.logout();
select tests.assert(pg_temp.in_stage((select id from t_order), 'awaiting_balance'), 'an arrived cvs preorder waits for the balance');
select tests.assert(pg_temp.in_stage((select id from t_order), 'ready_for_pickup'), 'the legacy status filter still works');
select tests.assert((select (public.admin_dashboard_stats(tests.id('admin')) -> 'stageCounts' ->> 'awaiting_balance')::integer = 1
                            and (public.admin_dashboard_stats(tests.id('admin')) ->> 'balanceReported')::integer = 0),
                    'the dashboard counts the awaiting balance stage; nothing reported yet');
select tests.login(tests.id('member_a'));
select public.submit_order_final_payment((select id from t_order), '22222');
select tests.logout();
select tests.assert(pg_temp.in_stage((select id from t_order), 'awaiting_balance') and not pg_temp.in_stage((select id from t_order), 'ready_to_ship'),
                    'a reported balance stays in awaiting balance until confirmed');
select tests.assert((select (public.admin_dashboard_stats(tests.id('admin')) ->> 'balanceReported')::integer = 1),
                    'the badge counts the reported balance');
select tests.as_service();
select public.admin_update_order_fulfillment(tests.id('admin'), (select id from t_order), 60, true, '22222', null);
select tests.logout();
select tests.assert(pg_temp.in_stage((select id from t_order), 'ready_to_ship'), 'a confirmed balance is ready to ship');
select tests.assert((select (public.admin_dashboard_stats(tests.id('admin')) ->> 'readyToShip')::integer = 1),
                    'the ready to ship card counts it');
select tests.as_service();
select tests.transition((select id from t_order), 'completed');
select tests.logout();
select tests.assert(pg_temp.in_stage((select id from t_order), 'completed'), 'a shipped order is completed');
select tests.assert((select coalesce((public.admin_dashboard_stats(tests.id('admin')) -> 'stageCounts' ->> 'completed'), '0') = '0'),
                    'closed orders are not counted');
rollback;

-- 現貨已確認、到店取貨預購到貨 → 待出貨；預購宅配到貨未填運費 → 待尾款；取消 → 失效訂單。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_stock on commit drop as select public.create_delivery_order(
    tests.order_items(tests.id('variant_stock'), 1), 'together', 'cvs_delivery', null, 0, tests.id('bank'), null, null,
    '王小明', '0912345678', '臺南市', '中西區', '民生門市', '123456') as id;
create temp table t_pickup on commit drop as select tests.place_order(tests.id('variant_pre'), 1) as id;
create temp table t_home on commit drop as select public.create_delivery_order(
    tests.order_items(tests.id('variant_pre'), 1), 'together', 'home_delivery', null, 0, tests.id('bank'), null,
    '臺南市中西區民生路二段 93 號', '王小明', '0912345678') as id;
create temp table t_cancel on commit drop as select tests.place_order(tests.id('variant_stock'), 1) as id;
grant select on t_stock, t_pickup, t_home, t_cancel to public;
select public.submit_order_payment((select id from t_stock), tests.id('bank'), '12345');
select public.submit_order_payment((select id from t_pickup), tests.id('bank'), '12345');
select public.submit_order_payment((select id from t_home), tests.id('bank'), '12345');
select tests.as_service();
select tests.transition((select id from t_stock), 'confirmed');
select tests.transition((select id from t_pickup), 'confirmed');
select tests.transition((select id from t_pickup), 'ready_for_pickup');
select tests.transition((select id from t_home), 'confirmed');
select tests.transition((select id from t_home), 'ready_for_pickup');
select tests.transition((select id from t_cancel), 'cancelled', '測試取消');
select tests.logout();
select tests.assert(pg_temp.in_stage((select id from t_stock), 'ready_to_ship') and not pg_temp.in_stage((select id from t_stock), 'awaiting_arrival'),
                    'a confirmed in-stock order is ready to ship');
select tests.assert(pg_temp.in_stage((select id from t_pickup), 'ready_to_ship'), 'an arrived store pickup preorder waits for pickup under ready to ship');
select tests.assert(pg_temp.in_stage((select id from t_home), 'awaiting_balance'), 'an arrived home preorder without a fee waits for the balance');
select tests.assert(pg_temp.in_stage((select id from t_cancel), 'cancelled'), 'a cancelled order is listed as void');
rollback;

-- 權限與輸入：非管理員、未知分類拒絕；分類函式不開放給 API 角色。
begin;
select tests.seed();
select tests.expect_error($$select public.admin_search_order_ids(tests.id('member_a'), '', 'ready_to_ship', 0, 100)$$,
                          'ADMIN_REQUIRED', 'members cannot search orders');
select tests.expect_error($$select public.admin_search_order_ids(tests.id('admin'), '', 'shipped_soon', 0, 100)$$,
                          'INVALID_ADMIN_ORDER_FILTER', 'unknown stages are rejected');
select tests.assert(not has_function_privilege('authenticated', 'private.admin_order_stage(public.orders)', 'EXECUTE'),
                    'members cannot call the stage helper');
rollback;
