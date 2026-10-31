-- 會員回報尾款末五碼：預購店到店／宅配到貨後、尾款確認前，本人可回報與改填，訂單狀態與金額不變；
-- 其他情況（未登入、他人訂單、未到貨、現貨、到店取貨、宅配運費未確認、尾款已確認、格式錯誤）一律拒絕且不留痕跡。

-- 預購店到店到貨：可回報、可改填（以最後一次為準），狀態與金額不變；管理員確認後不可再回報。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select public.create_delivery_order(
    tests.order_items(tests.id('variant_pre'), 1), 'together', 'cvs_delivery', null, 0, tests.id('bank'), null, null,
    '王小明', '0912345678', '臺南市', '中西區', '民生門市', '123456') as id;
grant select on t_order to public;
select public.submit_order_payment((select id from t_order), tests.id('bank'), '12345');
select tests.expect_error(format($$select public.submit_order_final_payment(%L, '11111')$$, (select id from t_order)),
                          'FINAL_PAYMENT_NOT_REPORTABLE', 'the balance cannot be reported before the goods arrive');
select tests.as_service();
select tests.transition((select id from t_order), 'confirmed');
select tests.transition((select id from t_order), 'ready_for_pickup');
select tests.login(tests.id('member_a'));
select public.submit_order_final_payment((select id from t_order), '11111');
select public.submit_order_final_payment((select id from t_order), '22222');
select tests.logout();
select tests.assert((select final_payment_reported_last_five = '22222' and final_payment_reported_at is not null
                            and status = 'ready_for_pickup' and paid_amount = 1000 and amount_due = 2060
                            and final_payment_confirmed_at is null and final_payment_last_five is null
                       from public.orders where id = (select id from t_order)),
                    'the latest report is kept and the order status and amounts are unchanged');
-- 管理員未勾確認儲存時，會員回報的末五碼仍保留
select tests.as_service();
select public.admin_update_order_fulfillment(tests.id('admin'), (select id from t_order), 60, false, null, '已收到通知');
select tests.logout();
select tests.assert((select final_payment_reported_last_five = '22222' from public.orders where id = (select id from t_order)),
                    'saving fulfillment without confirming keeps the member report');
select tests.as_service();
select public.admin_update_order_fulfillment(tests.id('admin'), (select id from t_order), 60, true, '22222', null);
select tests.login(tests.id('member_a'));
select tests.expect_error(format($$select public.submit_order_final_payment(%L, '33333')$$, (select id from t_order)),
                          'FINAL_PAYMENT_NOT_REPORTABLE', 'a confirmed balance cannot be reported again');
select tests.logout();
select tests.assert((select final_payment_reported_last_five = '22222' and final_payment_last_five = '22222' from public.orders where id = (select id from t_order)),
                    'the rejected report changed nothing');
rollback;

-- 他人、未登入、格式錯誤：拒絕且不寫入。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select public.create_delivery_order(
    tests.order_items(tests.id('variant_pre'), 1), 'together', 'cvs_delivery', null, 0, tests.id('bank'), null, null,
    '王小明', '0912345678', '臺南市', '中西區', '民生門市', '123456') as id;
grant select on t_order to public;
select public.submit_order_payment((select id from t_order), tests.id('bank'), '12345');
select tests.as_service();
select tests.transition((select id from t_order), 'confirmed');
select tests.transition((select id from t_order), 'ready_for_pickup');
select tests.login(tests.id('member_b'));
select tests.expect_error(format($$select public.submit_order_final_payment(%L, '11111')$$, (select id from t_order)),
                          'FINAL_PAYMENT_NOT_REPORTABLE', 'another member cannot report this balance');
select tests.login(tests.id('member_a'));
select tests.expect_error(format($$select public.submit_order_final_payment(%L, '1234')$$, (select id from t_order)),
                          'INVALID_PAYMENT_LAST_FIVE', 'four digits are rejected');
select tests.expect_error(format($$select public.submit_order_final_payment(%L, 'abcde')$$, (select id from t_order)),
                          'INVALID_PAYMENT_LAST_FIVE', 'letters are rejected');
select tests.login(null);
select tests.expect_error(format($$select public.submit_order_final_payment(%L, '11111')$$, (select id from t_order)),
                          'permission denied', 'anon cannot call the RPC');
select tests.logout();
select tests.assert((select final_payment_reported_last_five is null and final_payment_reported_at is null from public.orders where id = (select id from t_order)),
                    'rejected reports leave no trace');
rollback;

-- 預購宅配：運費確認前不可回報，確認後可回報。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select public.create_delivery_order(
    tests.order_items(tests.id('variant_pre'), 1), 'together', 'home_delivery', null, 0, tests.id('bank'), null,
    '臺南市中西區民生路二段 93 號', '王小明', '0912345678') as id;
grant select on t_order to public;
select public.submit_order_payment((select id from t_order), tests.id('bank'), '12345');
select tests.as_service();
select tests.transition((select id from t_order), 'confirmed');
select tests.transition((select id from t_order), 'ready_for_pickup');
select tests.login(tests.id('member_a'));
select tests.expect_error(format($$select public.submit_order_final_payment(%L, '11111')$$, (select id from t_order)),
                          'FINAL_PAYMENT_NOT_REPORTABLE', 'a home preorder cannot report before the fee is confirmed');
select tests.as_service();
select public.admin_update_order_fulfillment(tests.id('admin'), (select id from t_order), 150, false, null, null);
select tests.login(tests.id('member_a'));
select public.submit_order_final_payment((select id from t_order), '44444');
select tests.logout();
select tests.assert((select final_payment_reported_last_five = '44444' and status = 'ready_for_pickup' from public.orders where id = (select id from t_order)),
                    'a home preorder reports once the fee is confirmed');
rollback;

-- 到店取貨預購與現貨店到店：不在範圍內。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_pickup on commit drop as select tests.place_order(tests.id('variant_pre'), 1) as id;
create temp table t_stock on commit drop as select public.create_delivery_order(
    tests.order_items(tests.id('variant_stock'), 1), 'together', 'cvs_delivery', null, 0, tests.id('bank'), null, null,
    '王小明', '0912345678', '臺南市', '中西區', '民生門市', '123456') as id;
grant select on t_pickup, t_stock to public;
select public.submit_order_payment((select id from t_pickup), tests.id('bank'), '12345');
select public.submit_order_payment((select id from t_stock), tests.id('bank'), '12345');
select tests.as_service();
select tests.transition((select id from t_pickup), 'confirmed');
select tests.transition((select id from t_pickup), 'ready_for_pickup');
select tests.transition((select id from t_stock), 'confirmed');
select tests.transition((select id from t_stock), 'ready_for_pickup');
select tests.login(tests.id('member_a'));
select tests.expect_error(format($$select public.submit_order_final_payment(%L, '11111')$$, (select id from t_pickup)),
                          'FINAL_PAYMENT_NOT_REPORTABLE', 'store pickup preorders are out of scope');
select tests.expect_error(format($$select public.submit_order_final_payment(%L, '11111')$$, (select id from t_stock)),
                          'FINAL_PAYMENT_NOT_REPORTABLE', 'in-stock cvs orders have no balance');
select tests.logout();
rollback;
