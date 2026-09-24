-- 回報匯款與逾期取消：只有本人可回報、不能重複回報、逾期不可付款；逾期取消釋放保留量且可重複執行。

-- 回報匯款：本人回報後進入待確認，重複回報與他人代報都被拒絕。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select tests.place_order(tests.id('variant_stock'), 1) as id;
select tests.login(tests.id('member_b'));
select tests.expect_error(format($$select public.submit_order_payment(%L, tests.id('bank'), '12345')$$, (select id from t_order)),
                          'ORDER_NOT_PAYABLE', 'another member cannot report payment for this order');
select tests.login(tests.id('member_a'));
select tests.expect_error(format($$select public.submit_order_payment(%L, tests.id('bank'), '1234x')$$, (select id from t_order)),
                          'INVALID_PAYMENT_LAST_FIVE', 'last five digits are validated');
select public.submit_order_payment((select id from t_order), tests.id('bank'), '12345');
select tests.expect_error(format($$select public.submit_order_payment(%L, tests.id('bank'), '54321')$$, (select id from t_order)),
                          'ORDER_NOT_PAYABLE', 'payment cannot be reported twice');
select tests.logout();
select tests.assert((select status = 'pending_review' and payment_last_five = '12345' from public.orders where id = (select id from t_order)),
                    'first report is kept and the order waits for review');
select tests.assert(tests.available(tests.id('variant_stock')) = 4, 'reservation is kept while payment is reviewed');
rollback;

-- 付款期限已過：不可再回報。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select tests.place_order(tests.id('variant_stock'), 1) as id;
select tests.logout();
update public.orders set payment_deadline = now() - interval '1 minute' where id = (select id from t_order);
select tests.login(tests.id('member_a'));
select tests.expect_error(format($$select public.submit_order_payment(%L, tests.id('bank'), '12345')$$, (select id from t_order)),
                          'ORDER_NOT_PAYABLE', 'overdue order cannot be paid');
rollback;

-- 逾期取消：只取消已過期的待付款／待確認訂單，釋放保留量、寫入歷程、退回折抵點數；再執行一次不重複處理。
begin;
select tests.seed();
update public.product_variants set stock_on_hand = 10 where id = tests.id('variant_stock');
insert into public.point_ledger(member_id, kind, points, reason) values (tests.id('member_a'), 'manual', 50, '測試贈點');
select tests.login(tests.id('member_a'));
create temp table t_orders on commit drop as
select 'unpaid' as label, tests.place_order(tests.id('variant_stock'), 2) as id
union all
select 'reported', tests.place_order(tests.id('variant_stock'), 1)
union all
select 'on_time', tests.place_order(tests.id('variant_stock'), 1)
union all
select 'with_points', public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 1), 'together', 'store_pickup', null, 30,
                                                   tests.id('bank'), null, null, null, null);
select public.submit_order_payment((select id from t_orders where label = 'reported'), tests.id('bank'), '12345');
select tests.logout();
select tests.assert(tests.point_balance(tests.id('member_a')) = 20, 'points are deducted when the order is placed');
select tests.assert(tests.available(tests.id('variant_stock')) = 5, 'four orders reserve five units');
update public.orders set payment_deadline = now() - interval '1 minute'
 where id in (select id from t_orders where label <> 'on_time');
select tests.assert(public.cancel_expired_orders() = 3, 'three overdue orders are cancelled');
select tests.assert((select count(*) = 3 from public.orders where status = 'cancelled' and cancelled_at is not null), 'overdue orders are cancelled');
select tests.assert((select status = 'pending_payment' from public.orders where id = (select id from t_orders where label = 'on_time')),
                    'order within its deadline is untouched');
select tests.assert(tests.available(tests.id('variant_stock')) = 9, 'cancelled reservations are released');
select tests.assert((select count(*) = 3 from public.order_status_history where to_status = 'cancelled' and note = '付款期限逾期，系統自動取消'),
                    'each cancellation is recorded in the history');
select tests.assert(tests.point_balance(tests.id('member_a')) = 50, 'redeemed points are returned on expiry');
select tests.assert(public.cancel_expired_orders() = 0, 'second run finds nothing to cancel');
select tests.assert(tests.point_balance(tests.id('member_a')) = 50, 'second run does not return points twice');
rollback;

-- 會員不能直接呼叫逾期取消（只給排程與 service_role）。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
select tests.expect_error($$select public.cancel_expired_orders()$$, 'permission denied', 'members cannot run the expiry job');
rollback;
