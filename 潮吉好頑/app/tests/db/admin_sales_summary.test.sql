-- 後台月份業績（admin_sales_summary）與訂單月份篩選（admin_search_order_ids 的 p_month）：
-- 業績＝應付扣運費；已收＝已入帳；未收＝應付（含運費）扣已收；待付訂與失效訂單不計入；月份依台灣時間建單日期；非管理員與錯誤月份一律拒絕。

begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_orders on commit drop as
  select 'paid'::text as name, tests.place_order(tests.id('variant_stock'), 1) as id
  union all select 'pre', tests.place_order(tests.id('variant_pre'), 1)
  union all select 'unpaid', tests.place_order(tests.id('variant_stock'), 1)
  union all select 'cancelled', tests.place_order(tests.id('variant_stock'), 1);
grant select on t_orders to public;
select public.submit_order_payment((select id from t_orders where name = 'paid'), tests.id('bank'), '11111');
select public.submit_order_payment((select id from t_orders where name = 'pre'), tests.id('bank'), '22222');
select tests.logout();
select tests.as_service();
select tests.transition((select id from t_orders where name = 'paid'), 'confirmed');
select tests.transition((select id from t_orders where name = 'pre'), 'confirmed');
select tests.transition((select id from t_orders where name = 'cancelled'), 'cancelled', '客人取消');
select tests.logout();
-- 預購單加 NT$60 運費（應付含運），業績不能把運費算進去
update public.orders set shipping_fee = 60, amount_due = amount_due + 60 where id = (select id from t_orders where name = 'pre');
-- 兩筆移到上個月最後一刻與這個月第一刻（台灣時間），驗證月份邊界
update public.orders set created_at = '2026-10-31 23:59:59+08' where id = (select id from t_orders where name = 'paid');
update public.orders set created_at = '2026-11-01 00:00:00+08' where id = (select id from t_orders where name = 'pre');
update public.orders set created_at = '2026-11-02 12:00:00+08' where id in (select id from t_orders where name in ('unpaid', 'cancelled'));

create temp table t_all on commit drop as select public.admin_sales_summary(tests.id('admin')) as s;
select tests.assert((select (s ->> 'orderCount')::int = 2 from t_all), 'only paid-in orders count; unpaid and cancelled orders are excluded');
select tests.assert((select (s ->> 'revenue')::int = 3000 from t_all), 'revenue is the amount due without shipping');
select tests.assert((select (s ->> 'received')::int = 2000 from t_all), 'received sums the confirmed payments');
select tests.assert((select (s ->> 'outstanding')::int = 1060 from t_all), 'outstanding includes the shipping fee');
select tests.assert((select s ->> 'month' = 'all' from t_all), 'no month means all months');
select tests.assert((select s -> 'months' = '["2026-11", "2026-10"]'::jsonb from t_all), 'months list every Taipei month that has orders, newest first');

select tests.assert((select (public.admin_sales_summary(tests.id('admin'), '2026-11') ->> 'revenue')::int = 2000),
                    'an order placed at 00:00 Taipei on the 1st belongs to that month');
select tests.assert((select (public.admin_sales_summary(tests.id('admin'), '2026-10') ->> 'revenue')::int = 1000),
                    'an order placed at 23:59 Taipei on the last day stays in the earlier month');
select tests.assert((select (public.admin_sales_summary(tests.id('admin'), '2026-09') ->> 'orderCount')::int = 0),
                    'a month without orders sums to zero');

select tests.assert((select jsonb_array_length(public.admin_search_order_ids(tests.id('admin'), '', 'all', 0, 100, '2026-11') -> 'ids') = 3),
                    'the order month filter keeps every status in that month');
select tests.assert((select public.admin_search_order_ids(tests.id('admin'), '', 'all', 0, 100, '2026-10') -> 'ids' = to_jsonb(array[(select id from t_orders where name = 'paid')])),
                    'the order month filter uses the Taipei month');
select tests.assert((select jsonb_array_length(public.admin_search_order_ids(tests.id('admin'), '', 'all', 0, 100) -> 'ids') = 4),
                    'the old five-argument call still lists every month');
select tests.assert((select jsonb_array_length(public.admin_search_order_ids(tests.id('admin'), '', 'cancelled', 0, 100, '2026-11') -> 'ids') = 1),
                    'the month filter combines with the status filter');

select tests.expect_error($$select public.admin_sales_summary(tests.id('admin'), '2026-13')$$, 'INVALID_ADMIN_MONTH', 'an invalid month is rejected');
select tests.expect_error($$select public.admin_search_order_ids(tests.id('admin'), '', 'all', 0, 100, 'last-month')$$, 'INVALID_ADMIN_MONTH', 'an invalid order month is rejected');
select tests.expect_error($$select public.admin_sales_summary(tests.id('member_a'))$$, 'ADMIN_REQUIRED', 'a member cannot read sales');
rollback;
