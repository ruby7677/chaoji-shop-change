-- 7-11 店到店（交貨便）：運費與免運門檻、預購訂金不含運費、收件人與門市必填、賣貨便停止新建、
-- 未付清不可完成（出貨）、運費不可改、寄件編號權限、點數不含運費。

-- 現貨：未滿 6,000 收 60 元，建單即付清商品與運費；收件人與門市寫入訂單。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select public.create_delivery_order(
    tests.order_items(tests.id('variant_stock'), 1), 'together', 'cvs_delivery', null, 0, tests.id('bank'), null, null,
    ' 王小明 ', '0912-345-678', '臺南市', '中西區', '民生門市', ' 123456 ') as id;
select tests.logout();
select tests.assert((select subtotal = 1000 and shipping_fee = 60 and amount_due = 1060 and deposit_due = 1060
                            and payment_deadline = now() + interval '24 hours' and status = 'pending_payment'
                       from public.orders where id = (select id from t_order)),
                    'in-stock cvs order charges 60 shipping and is paid in full upfront');
select tests.assert((select shipping_recipient_name = '王小明' and shipping_phone = '0912345678'
                            and pickup_store_city = '臺南市' and pickup_store_district = '中西區'
                            and pickup_store_name = '民生門市' and pickup_store_code = '123456' and shipping_address is null
                       from public.orders where id = (select id from t_order)),
                    'recipient and pickup store are stored trimmed');
rollback;

-- 滿 6,000 免運；門檻看折抵前的商品小計（優惠券折抵後低於 6,000 仍免運）。
begin;
select tests.seed();
update public.product_variants set price = 1500 where id = tests.id('variant_stock');
insert into public.coupons(code, name, discount_amount, combinable_with_points, valid_from, valid_until, per_member_limit)
values ('CVS100', '測試折價券', 100, true, now() - interval '1 day', now() + interval '30 days', 1);
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select public.create_delivery_order(
    tests.order_items(tests.id('variant_stock'), 4), 'together', 'cvs_delivery', 'CVS100', 0, tests.id('bank'), null, null,
    '王小明', '0912345678', '臺南市', '中西區', '民生門市', '123456') as id;
select tests.logout();
select tests.assert((select subtotal = 6000 and coupon_discount = 100 and shipping_fee = 0 and amount_due = 5900 and deposit_due = 5900
                       from public.orders where id = (select id from t_order)),
                    'subtotal of 6000 before discounts ships free');
rollback;

-- 預購：訂金 50% 不含運費，運費計入訂單總額，付款期限 2 小時。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select public.create_delivery_order(
    tests.order_items(tests.id('variant_pre'), 1), 'together', 'cvs_delivery', null, 0, tests.id('bank'), null, null,
    '王小明', '0912345678', '臺南市', '中西區', '民生門市', '123456') as id;
select tests.logout();
select tests.assert((select shipping_fee = 60 and amount_due = 2060 and deposit_due = 1000
                            and payment_deadline = now() + interval '2 hours'
                       from public.orders where id = (select id from t_order)),
                    'preorder cvs deposit excludes shipping, total includes it');
rollback;

-- 拒絕：門市不完整、店號格式、缺收件人、舊 10 參數入口選交貨便、賣貨便新建；全部不留資料。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
select tests.expect_error(
  $$select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 1), 'together', 'cvs_delivery', null, 0, tests.id('bank'), null, null,
      '王小明', '0912345678', '臺南市', '中西區', '  ', '123456')$$,
  'CVS_PICKUP_STORE_REQUIRED', 'cvs order needs a store name');
select tests.expect_error(
  $$select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 1), 'together', 'cvs_delivery', null, 0, tests.id('bank'), null, null,
      '王小明', '0912345678', '臺南市', '中西區', '民生門市', '12345')$$,
  'CVS_PICKUP_STORE_CODE_INVALID', 'store code must be 6 digits');
select tests.expect_error(
  $$select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 1), 'together', 'cvs_delivery', null, 0, tests.id('bank'), null, null,
      null, '0912345678', '臺南市', '中西區', '民生門市', '123456')$$,
  'SHIPPING_RECIPIENT_REQUIRED', 'cvs order needs a recipient name');
select tests.expect_error(
  $$select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 1), 'together', 'cvs_delivery', null, 0, tests.id('bank'), null, null,
      '王小明', '0912345678')$$,
  'CVS_PICKUP_STORE_REQUIRED', 'legacy 10-argument entry cannot create a cvs order without a store');
select tests.expect_error(
  $$select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 1), 'together', 'seller_delivery', null, 0, tests.id('bank'), null, null, null, null)$$,
  'SELLER_DELIVERY_RETIRED', 'new seller-delivery orders are rejected');
select tests.expect_error(
  $$select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 1), 'together', 'seller_delivery', null, 0, null, null, null, null, null)$$,
  'SELLER_DELIVERY_RETIRED', 'seller-delivery external payment is rejected');
select tests.logout();
select tests.assert((select count(*) = 0 from public.orders), 'rejected cvs orders leave no rows');
rollback;

-- 預購交貨便：確認訂金、到貨後，未確認尾款不可完成；運費固定不可改；確認尾款後可完成並付清。
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
select tests.expect_error(format($$select tests.transition(%L, 'completed')$$, (select id from t_order)),
                          'FINAL_PAYMENT_REQUIRED', 'preorder cvs cannot ship before the balance is paid');
select tests.expect_error(format($$select public.admin_update_order_fulfillment(tests.id('admin'), %L, 0, true, '54321', null)$$, (select id from t_order)),
                          'CVS_SHIPPING_FEE_FIXED', 'cvs shipping fee cannot be changed');
select public.admin_update_order_fulfillment(tests.id('admin'), (select id from t_order), 60, true, '54321', null);
select tests.transition((select id from t_order), 'completed');
select tests.logout();
select tests.assert((select status = 'completed' and paid_amount = 2060 and amount_due = 2060 from public.orders where id = (select id from t_order)),
                    'preorder cvs completes after the balance and shipping are confirmed');
rollback;

-- 現貨交貨便：確認付款即付清，可直接完成；點數只算商品金額，不含運費。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select public.create_delivery_order(
    tests.order_items(tests.id('variant_stock'), 1), 'together', 'cvs_delivery', null, 0, tests.id('bank'), null, null,
    '王小明', '0912345678', '臺南市', '中西區', '民生門市', '123456') as id;
grant select on t_order to public;
select public.submit_order_payment((select id from t_order), tests.id('bank'), '12345');
select tests.as_service();
select tests.transition((select id from t_order), 'confirmed');
select tests.transition((select id from t_order), 'completed');
select tests.logout();
select tests.assert((select paid_amount = 1060 from public.orders where id = (select id from t_order)), 'in-stock cvs is fully paid');
select tests.assert(tests.point_balance(tests.id('member_a')) = (select floor(1000.0 / earn_amount_per_point)::integer from public.point_settings where id),
                    'earned points exclude the shipping fee');
rollback;

-- 寄件編號：只有管理 RPC（service_role）可寫、只限交貨便、格式檢查；會員不可改門市與寄件編號欄位。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select public.create_delivery_order(
    tests.order_items(tests.id('variant_stock'), 1), 'together', 'cvs_delivery', null, 0, tests.id('bank'), null, null,
    '王小明', '0912345678', '臺南市', '中西區', '民生門市', '123456') as id;
grant select on t_order to public;
create temp table t_pickup on commit drop as select tests.place_order(tests.id('variant_stock'), 1) as id;
grant select on t_pickup to public;
select tests.expect_error(format($$select public.admin_set_order_shipment_tracking(tests.id('admin'), %L, 'A123')$$, (select id from t_order)),
                          'permission denied', 'members cannot call the tracking RPC');
select tests.as_service();
select tests.expect_error(format($$select public.admin_set_order_shipment_tracking(tests.id('member_b'), %L, 'A123')$$, (select id from t_order)),
                          'ADMIN_REQUIRED', 'only admins can set tracking numbers');
select tests.expect_error(format($$select public.admin_set_order_shipment_tracking(tests.id('admin'), %L, 'A1 23<')$$, (select id from t_order)),
                          'INVALID_TRACKING_NUMBER', 'tracking number format is checked');
select tests.expect_error(format($$select public.admin_set_order_shipment_tracking(tests.id('admin'), %L, 'A123')$$, (select id from t_pickup)),
                          'TRACKING_NUMBER_CVS_ONLY', 'tracking numbers are only for cvs orders');
select public.admin_set_order_shipment_tracking(tests.id('admin'), (select id from t_order), ' F12345678 ');
select tests.logout();
select tests.assert((select shipment_tracking_number = 'F12345678' from public.orders where id = (select id from t_order)),
                    'tracking number is stored without spaces');
select tests.assert(not has_column_privilege('authenticated', 'public.orders', 'pickup_store_code', 'UPDATE')
                    and not has_column_privilege('authenticated', 'public.orders', 'shipment_tracking_number', 'UPDATE'),
                    'members cannot update pickup store or tracking columns');
rollback;
