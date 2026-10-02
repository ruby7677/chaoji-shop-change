-- 管理員訂單狀態：確認付款才扣庫存且只扣一次、庫存不足整筆回滾、取消回補、點數入帳與退款扣回、權限。

-- 確認付款：扣實體庫存、寫入 sale 異動、釋放保留量；重複確認被拒絕且不再扣庫存。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select tests.place_order(tests.id('variant_stock'), 2) as id;
grant select on t_order to public;
select public.submit_order_payment((select id from t_order), tests.id('bank'), '12345');
select tests.as_service();
select tests.transition((select id from t_order), 'confirmed');
select tests.expect_error(format($$select tests.transition(%L, 'confirmed')$$, (select id from t_order)),
                          'ORDER_STATUS_UNCHANGED', 'confirming twice is rejected');
select tests.logout();
select tests.assert((select stock_on_hand = 3 from public.product_variants where id = tests.id('variant_stock')), 'stock is deducted exactly once');
select tests.assert((select count(*) = 1 and sum(quantity_delta) = -2 from public.inventory_movements
                      where order_id = (select id from t_order) and kind = 'sale'), 'one sale movement is recorded');
select tests.assert((select bool_and(released_at is not null) from public.inventory_reservations where order_id = (select id from t_order)),
                    'reservation is released after the sale');
select tests.assert(tests.available(tests.id('variant_stock')) = 3, 'available stock equals physical stock after confirmation');
select tests.assert((select paid_amount = deposit_due and payment_confirmed_at is not null from public.orders where id = (select id from t_order)),
                    'paid amount and confirmation time are set');
rollback;

-- 確認時第二個規格實體庫存不足：第一個規格已扣的庫存也要回滾，訂單維持待確認。
begin;
select tests.seed();
insert into public.product_variants(id, product_id, name, sku, kind, price, stock_on_hand, deposit_rate, is_published)
values ('00000000-0000-4000-8000-0000000000b3', tests.id('product_stock'), '規格 B', 'TEST-STOCK-B', 'in_stock', 500, 5, 0, true);
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as
select public.create_delivery_order(
  jsonb_build_array(jsonb_build_object('variant_id', tests.id('variant_stock'), 'quantity', 1),
                    jsonb_build_object('variant_id', '00000000-0000-4000-8000-0000000000b3', 'quantity', 1)),
  'together', 'store_pickup', null, 0, tests.id('bank'), null, null, null, null) as id;
grant select on t_order to public;
select public.submit_order_payment((select id from t_order), tests.id('bank'), '12345');
select tests.logout();
update public.product_variants set stock_on_hand = 0 where id = '00000000-0000-4000-8000-0000000000b3';
select tests.as_service();
select tests.expect_error(format($$select tests.transition(%L, 'confirmed')$$, (select id from t_order)),
                          'INSUFFICIENT_STOCK', 'confirmation fails when physical stock is short');
select tests.logout();
select tests.assert((select stock_on_hand = 5 from public.product_variants where id = tests.id('variant_stock')),
                    'stock already deducted for the first variant is rolled back');
select tests.assert((select count(*) = 0 from public.inventory_movements where order_id = (select id from t_order)), 'no sale movement remains');
select tests.assert((select status = 'pending_review' from public.orders where id = (select id from t_order)), 'order stays pending review');
rollback;

-- 取消：必須填原因；已確認的訂單取消時回補庫存且只回補一次。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select tests.place_order(tests.id('variant_stock'), 2) as id;
grant select on t_order to public;
select public.submit_order_payment((select id from t_order), tests.id('bank'), '12345');
select tests.as_service();
select tests.transition((select id from t_order), 'confirmed');
select tests.expect_error(format($$select tests.transition(%L, 'cancelled')$$, (select id from t_order)),
                          'ORDER_NOTE_REQUIRED', 'cancellation needs a reason');
select tests.transition((select id from t_order), 'cancelled', '客人取消', 2000);
select tests.expect_error(format($$select tests.transition(%L, 'cancelled', '再取消一次')$$, (select id from t_order)),
                          'ORDER_STATUS_UNCHANGED', 'cancelling twice is rejected');
select tests.logout();
select tests.assert((select stock_on_hand = 5 from public.product_variants where id = tests.id('variant_stock')), 'stock is restored once');
select tests.assert((select count(*) = 1 and sum(quantity_delta) = 2 from public.inventory_movements
                      where order_id = (select id from t_order) and kind = 'refund' and source_movement_id is not null),
                    'one refund movement points back to the sale');
rollback;

-- 不合法的狀態跳轉與未回報付款就確認。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select tests.place_order(tests.id('variant_stock'), 1) as id;
grant select on t_order to public;
select tests.as_service();
select tests.expect_error(format($$select tests.transition(%L, 'completed')$$, (select id from t_order)),
                          'INVALID_ORDER_TRANSITION', 'pending payment cannot jump to completed');
select tests.expect_error(format($$select tests.transition(%L, 'confirmed')$$, (select id from t_order)),
                          'INVALID_ORDER_TRANSITION', 'bank transfer order needs a payment report before confirmation');
rollback;

-- 點數：下單折抵、取消退回；完成訂單入點，退款扣回已賺點數並退回折抵。
begin;
select tests.seed();
insert into public.point_ledger(member_id, kind, points, reason) values (tests.id('member_a'), 'manual', 50, '測試贈點');
select tests.login(tests.id('member_a'));
select tests.expect_error(
  $$select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 1), 'together', 'store_pickup', null, 60, tests.id('bank'), null, null, null, null)$$,
  'INSUFFICIENT_POINTS', 'cannot redeem more points than the balance');
create temp table t_order on commit drop as
select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 2), 'together', 'store_pickup', null, 30,
                                    tests.id('bank'), null, null, null, null) as id;
grant select on t_order to public;
select public.submit_order_payment((select id from t_order), tests.id('bank'), '12345');
select tests.logout();
select tests.assert((select point_discount = 30 and amount_due = 1970 from public.orders where id = (select id from t_order)),
                    'point discount lowers the amount due');
select tests.assert(tests.point_balance(tests.id('member_a')) = 20, 'redeemed points leave the balance');
select tests.as_service();
select tests.transition((select id from t_order), 'confirmed');
select tests.transition((select id from t_order), 'completed');
select tests.logout();
select tests.assert(tests.point_balance(tests.id('member_a')) = 39, 'completing earns floor((2000 - 30) / 100) = 19 points');
select tests.as_service();
select tests.transition((select id from t_order), 'refund_pending', '退款');
select tests.transition((select id from t_order), 'refunded', '已退款', 1970);
select tests.logout();
select tests.assert(tests.point_balance(tests.id('member_a')) = 50, 'refund returns redeemed points and removes earned points');
select tests.assert((select count(*) = 1 from public.point_ledger where order_id = (select id from t_order) and kind = 'earn'), 'points are earned once');
rollback;

-- 權限：非管理員 actor 被拒；會員（即使 is_admin）不能直接呼叫管理 RPC，只能經 Worker 的 service_role。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select tests.place_order(tests.id('variant_stock'), 1) as id;
grant select on t_order to public;
select tests.as_service();
select tests.expect_error(format($$select public.admin_transition_order(tests.id('member_b'), %L, 'cancelled', '冒用')$$, (select id from t_order)),
                          'ADMIN_REQUIRED', 'actor must be an admin');
select tests.login(tests.id('admin'));
select tests.expect_error(format($$select public.admin_transition_order(tests.id('admin'), %L, 'cancelled', '直接呼叫')$$, (select id from t_order)),
                          'permission denied', 'admin JWT cannot call the admin RPC directly');
select tests.expect_error($$select public.admin_adjust_inventory(tests.id('admin'), tests.id('variant_stock'), 10, '直接呼叫')$$,
                          'permission denied', 'inventory RPC is not exposed to members');
select tests.logout();
select tests.assert((select status = 'pending_payment' from public.orders where id = (select id from t_order)), 'order is unchanged');
rollback;

-- 退款金額：取消已付款訂單與確認已退款必填、0 到應付總額之間；未付款取消固定 0；其他狀態不可帶金額；寫入訂單與狀態歷程。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select tests.place_order(tests.id('variant_stock'), 1) as id;
grant select on t_order to public;
select public.submit_order_payment((select id from t_order), tests.id('bank'), '12345');
select tests.as_service();
select tests.transition((select id from t_order), 'confirmed');
select tests.expect_error(format($$select tests.transition(%L, 'cancelled', '客人取消')$$, (select id from t_order)),
                          'REFUND_AMOUNT_REQUIRED', 'cancelling a paid order needs a refund amount');
select tests.expect_error(format($$select tests.transition(%L, 'cancelled', '客人取消', -1)$$, (select id from t_order)),
                          'INVALID_REFUND_AMOUNT', 'negative refund is rejected');
select tests.expect_error(format($$select tests.transition(%L, 'cancelled', '客人取消', 1001)$$, (select id from t_order)),
                          'INVALID_REFUND_AMOUNT', 'refund above the amount due is rejected');
select tests.expect_error(format($$select tests.transition(%L, 'ready_for_pickup', null, 100)$$, (select id from t_order)),
                          'REFUND_AMOUNT_NOT_APPLICABLE', 'other transitions cannot carry a refund amount');
select (tests.transition((select id from t_order), 'cancelled', '客人取消', 1000) ->> 'refunded_amount')::integer = 1000 as returned;
select tests.logout();
select tests.assert((select status = 'cancelled' and refunded_amount = 1000 from public.orders where id = (select id from t_order)),
                    'refund amount is stored on the cancelled order');
select tests.assert((select note = '客人取消（退款 NT$1000）' from public.order_status_history where order_id = (select id from t_order) and to_status = 'cancelled'),
                    'status history note records the refund');
rollback;

begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select tests.place_order(tests.id('variant_stock'), 1) as id;
grant select on t_order to public;
select tests.as_service();
select tests.expect_error(format($$select tests.transition(%L, 'cancelled', '未付款', 500)$$, (select id from t_order)),
                          'REFUND_NOT_ALLOWED_UNPAID', 'an unpaid order cannot record a refund');
select tests.transition((select id from t_order), 'cancelled', '未付款');
select tests.logout();
select tests.assert((select refunded_amount = 0 from public.orders where id = (select id from t_order)), 'unpaid cancellation stores a zero refund');
select tests.assert((select note = '未付款' from public.order_status_history where order_id = (select id from t_order) and to_status = 'cancelled'),
                    'unpaid cancellation note is unchanged');
rollback;
