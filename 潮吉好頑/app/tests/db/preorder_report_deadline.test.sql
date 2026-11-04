-- 預購訂單回報匯款後，付款期限與庫存保留延長為回報起 12 小時；現貨訂單的期限不變；期限已過仍不可回報。

-- 預購：建單 2 小時，回報後延長到約 12 小時，保留量到期時間同步延長，原本會逾期的時間點不再被取消。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_pre on commit drop as select tests.place_order(tests.id('variant_pre'), 1) as id;
select tests.assert((select payment_deadline < now() + interval '3 hours' from public.orders where id = (select id from t_pre)), 'a new preorder starts with the 2 hour deadline');
select public.submit_order_payment((select id from t_pre), tests.id('bank'), '12345');
select tests.logout();
select tests.assert((select payment_deadline > now() + interval '11 hours' and payment_deadline <= now() + interval '12 hours' from public.orders where id = (select id from t_pre)),
                    'reporting a preorder payment extends the deadline to about 12 hours');
select tests.assert((select bool_and(expires_at = (select payment_deadline from public.orders where id = (select id from t_pre)))
                       from public.inventory_reservations where order_id = (select id from t_pre) and released_at is null),
                    'the reservation follows the extended deadline');
select tests.assert(public.cancel_expired_orders() = 0, 'a reported preorder is not cancelled by the old 2 hour mark');
rollback;

-- 預購：期限延長後真的過期仍會取消並釋放保留量。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_pre on commit drop as select tests.place_order(tests.id('variant_pre'), 1) as id;
select public.submit_order_payment((select id from t_pre), tests.id('bank'), '12345');
select tests.logout();
update public.orders set payment_deadline = now() - interval '1 minute' where id = (select id from t_pre);
select tests.assert(public.cancel_expired_orders() = 1, 'the extended preorder is still cancelled once the new deadline passes');
select tests.assert((select status = 'cancelled' from public.orders where id = (select id from t_pre)), 'the overdue reported preorder is cancelled');
rollback;

-- 現貨：回報後期限不變（建單就是 24 小時）。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_stock on commit drop as select tests.place_order(tests.id('variant_stock'), 1) as id;
create temp table t_before on commit drop as select payment_deadline as d from public.orders where id = (select id from t_stock);
select public.submit_order_payment((select id from t_stock), tests.id('bank'), '12345');
select tests.logout();
select tests.assert((select payment_deadline = (select d from t_before) from public.orders where id = (select id from t_stock)), 'an in-stock order keeps its deadline when reported');
rollback;

-- 預購：期限已過不可回報，期限也不會被延長。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_pre on commit drop as select tests.place_order(tests.id('variant_pre'), 1) as id;
select tests.logout();
update public.orders set payment_deadline = now() - interval '1 minute' where id = (select id from t_pre);
select tests.login(tests.id('member_a'));
select tests.expect_error(format($$select public.submit_order_payment(%L, tests.id('bank'), '12345')$$, (select id from t_pre)),
                          'ORDER_NOT_PAYABLE', 'an overdue preorder cannot be reported');
select tests.logout();
select tests.assert((select payment_deadline < now() and status = 'pending_payment' from public.orders where id = (select id from t_pre)), 'the rejected report changed nothing');
rollback;

-- 建單時就帶末五碼：預購直接進待核對並拿到 12 小時，保留量同步；現貨維持 24 小時。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_pre on commit drop as
select public.create_delivery_order(tests.order_items(tests.id('variant_pre'), 1), 'together', 'store_pickup', null, 0, tests.id('bank'), '12345', null, null, null, null, null, null, null) as id;
create temp table t_stock on commit drop as
select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 1), 'together', 'store_pickup', null, 0, tests.id('bank'), '12345', null, null, null, null, null, null, null) as id;
select tests.logout();
select tests.assert((select status = 'pending_review' and payment_deadline > now() + interval '11 hours' and payment_deadline <= now() + interval '12 hours'
                       from public.orders where id = (select id from t_pre)), 'a preorder created with last five gets the 12 hour deadline');
select tests.assert((select bool_and(expires_at = (select payment_deadline from public.orders where id = (select id from t_pre)))
                       from public.inventory_reservations where order_id = (select id from t_pre) and released_at is null),
                    'its reservation matches the 12 hour deadline');
select tests.assert((select payment_deadline > now() + interval '23 hours' from public.orders where id = (select id from t_stock)), 'an in-stock order created with last five keeps 24 hours');
rollback;
