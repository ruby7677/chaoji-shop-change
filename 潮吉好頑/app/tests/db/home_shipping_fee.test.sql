-- 現貨宅配：待付款時由管理員確認運費，本次應付改為含運總額、付款期限與保留量重給 24 小時；
-- 運費 0 也記錄已確認；待付款不可確認尾款；已逾期不可延長；預購宅配待付款不改本次應付。

-- 待付款儲存運費：本次應付＝商品＋運費，期限與保留量延長，回報並確認付款後已收含運總額。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select public.create_delivery_order(
    tests.order_items(tests.id('variant_stock'), 1), 'together', 'home_delivery', null, 0, tests.id('bank'), null,
    '臺南市中西區民生路二段 93 號', '王小明', '0912345678') as id;
grant select on t_order to public;
select tests.logout();
select tests.assert((select shipping_fee = 0 and amount_due = 1000 and deposit_due = 1000 and shipping_fee_notified_at is null
                       from public.orders where id = (select id from t_order)),
                    'new in-stock home order has no shipping fee yet');
select tests.as_service();
update public.orders set payment_deadline = now() + interval '1 hour' where id = (select id from t_order);
update public.inventory_reservations set expires_at = now() + interval '1 hour' where order_id = (select id from t_order);
select public.admin_update_order_fulfillment(tests.id('admin'), (select id from t_order), 150, false, null, null);
select tests.assert((select shipping_fee = 150 and amount_due = 1150 and deposit_due = 1150 and shipping_fee_notified_at is not null
                            and status = 'pending_payment' and payment_deadline = now() + interval '24 hours'
                       from public.orders where id = (select id from t_order)),
                    'saving the fee on an unpaid in-stock home order charges goods plus shipping and restarts the 24-hour deadline');
select tests.assert((select bool_and(expires_at = now() + interval '24 hours') from public.inventory_reservations
                      where order_id = (select id from t_order) and released_at is null),
                    'the stock reservation is extended with the payment deadline');
select tests.expect_error(format($$select public.admin_update_order_fulfillment(tests.id('admin'), %L, 150, true, '54321', null)$$, (select id from t_order)),
                          'FINAL_PAYMENT_NOT_ALLOWED', 'final payment cannot be confirmed before the member pays');
select tests.logout();
select tests.login(tests.id('member_a'));
select public.submit_order_payment((select id from t_order), tests.id('bank'), '12345');
select tests.as_service();
select tests.transition((select id from t_order), 'confirmed');
select tests.logout();
select tests.assert((select status = 'confirmed' and paid_amount = 1150 from public.orders where id = (select id from t_order)),
                    'confirming the reported payment records goods plus shipping as paid');
rollback;

-- 免運（運費 0）也算已確認；不縮短較晚的期限。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select public.create_delivery_order(
    tests.order_items(tests.id('variant_stock'), 1), 'together', 'home_delivery', null, 0, tests.id('bank'), null,
    '臺南市中西區民生路二段 93 號', '王小明', '0912345678') as id;
grant select on t_order to public;
select tests.logout();
select tests.as_service();
update public.orders set payment_deadline = now() + interval '30 hours' where id = (select id from t_order);
select public.admin_update_order_fulfillment(tests.id('admin'), (select id from t_order), 0, false, null, null);
select tests.logout();
select tests.assert((select shipping_fee = 0 and amount_due = 1000 and deposit_due = 1000 and shipping_fee_notified_at is not null
                            and payment_deadline = now() + interval '30 hours'
                       from public.orders where id = (select id from t_order)),
                    'a zero fee is recorded as confirmed and a later deadline is kept');
rollback;

-- 已逾期（排程尚未取消）的訂單不可延長期限。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select public.create_delivery_order(
    tests.order_items(tests.id('variant_stock'), 1), 'together', 'home_delivery', null, 0, tests.id('bank'), null,
    '臺南市中西區民生路二段 93 號', '王小明', '0912345678') as id;
grant select on t_order to public;
select tests.logout();
select tests.as_service();
update public.orders set payment_deadline = now() - interval '1 minute' where id = (select id from t_order);
select tests.expect_error(format($$select public.admin_update_order_fulfillment(tests.id('admin'), %L, 150, false, null, null)$$, (select id from t_order)),
                          'PAYMENT_DEADLINE_PASSED', 'an expired unpaid order cannot be revived by saving the fee');
select tests.logout();
rollback;

-- 預購宅配待付款：運費只計入訂單總額，本次應付（訂金）不變。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select public.create_delivery_order(
    tests.order_items(tests.id('variant_pre'), 1), 'together', 'home_delivery', null, 0, tests.id('bank'), null,
    '臺南市中西區民生路二段 93 號', '王小明', '0912345678') as id;
grant select on t_order to public;
select tests.logout();
create temp table t_before on commit drop as
  select deposit_due, payment_deadline from public.orders where id = (select id from t_order);
select tests.as_service();
select public.admin_update_order_fulfillment(tests.id('admin'), (select id from t_order), 150, false, null, null);
select tests.logout();
select tests.assert((select o.deposit_due = b.deposit_due and o.payment_deadline = b.payment_deadline and o.shipping_fee = 150
                       from public.orders o, t_before b where o.id = (select id from t_order)),
                    'a preorder home order keeps its deposit and deadline when the fee is saved');
rollback;
