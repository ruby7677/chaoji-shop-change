-- 優惠券核銷：折抵金額、寫入 coupon_redemptions，以及各種拒絕案例。
-- 優惠券驗證與折抵計算目前併入 create_delivery_order（202609110002_delivery_methods.sql 起），
-- 舊版獨立的 create_discounted_order 已於 202609250003_drop_legacy_rpcs.sql 移除；
-- 本檔一律透過 create_delivery_order 觸發優惠券邏輯，與 order_creation.test.sql 相同呼叫慣例。

-- 一般優惠券折抵訂單金額，並寫入一筆核銷紀錄。
begin;
select tests.seed();
insert into public.coupons(code, name, discount_amount, combinable_with_points, valid_from, valid_until, per_member_limit)
values ('TESTCOUPON', '測試折價券', 100, true, now() - interval '1 day', now() + interval '30 days', 1);
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select public.create_delivery_order(
    tests.order_items(tests.id('variant_stock'), 2), 'together', 'store_pickup', 'TESTCOUPON', 0,
    tests.id('bank'), null, null, null, null) as id;
select tests.logout();
select tests.assert((select subtotal = 2000 and coupon_discount = 100 and amount_due = 1900 and deposit_due = 1900
                            and coupon_id is not null
                       from public.orders where id = (select id from t_order)),
                    'coupon discount reduces amount and deposit due and is recorded on the order');
select tests.assert((select count(*) = 1 from public.coupon_redemptions
                       where order_id = (select id from t_order)
                         and member_id = tests.id('member_a')
                         and discount_amount = 100),
                    'coupon redemption is recorded once with the discounted amount');
rollback;

-- 不存在的優惠券代碼。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
select tests.expect_error(
  $$select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 1), 'together', 'store_pickup', 'NOSUCHCODE', 0, tests.id('bank'), null, null, null, null)$$,
  'COUPON_NOT_FOUND', 'unknown coupon code is rejected');
select tests.logout();
select tests.assert((select count(*) = 0 from public.orders), 'rejected order leaves no rows');
rollback;

-- 已過期的優惠券。
begin;
select tests.seed();
insert into public.coupons(code, name, discount_amount, valid_from, valid_until)
values ('EXPIRED1', '過期券', 100, now() - interval '10 days', now() - interval '1 day');
select tests.login(tests.id('member_a'));
select tests.expect_error(
  $$select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 1), 'together', 'store_pickup', 'EXPIRED1', 0, tests.id('bank'), null, null, null, null)$$,
  'COUPON_EXPIRED', 'expired coupon is rejected');
select tests.logout();
select tests.assert((select count(*) = 0 from public.orders), 'rejected order leaves no rows');
rollback;

-- 已停用（is_active = false）的優惠券；資料庫與過期共用同一個錯誤代碼。
begin;
select tests.seed();
insert into public.coupons(code, name, discount_amount, valid_from, valid_until, is_active)
values ('INACTIVE1', '停用券', 100, now() - interval '1 day', now() + interval '30 days', false);
select tests.login(tests.id('member_a'));
select tests.expect_error(
  $$select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 1), 'together', 'store_pickup', 'INACTIVE1', 0, tests.id('bank'), null, null, null, null)$$,
  'COUPON_EXPIRED', 'inactive coupon is rejected');
select tests.logout();
select tests.assert((select count(*) = 0 from public.orders), 'rejected order leaves no rows');
rollback;

-- coupon_products 限定商品：訂單內沒有該商品時整張折抵基數為 0，視為不適用。
begin;
select tests.seed();
create temp table t_coupon on commit drop as
  with c as (
    insert into public.coupons(code, name, discount_amount, valid_from, valid_until)
    values ('PRODONLY1', '限定商品券', 100, now() - interval '1 day', now() + interval '30 days')
    returning id
  )
  select id from c;
insert into public.coupon_products(coupon_id, product_id) values ((select id from t_coupon), tests.id('product_pre'));
select tests.login(tests.id('member_a'));
select tests.expect_error(
  $$select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 1), 'together', 'store_pickup', 'PRODONLY1', 0, tests.id('bank'), null, null, null, null)$$,
  'COUPON_PRODUCT_NOT_ELIGIBLE', 'coupon restricted to another product is rejected');
select tests.logout();
select tests.assert((select count(*) = 0 from public.orders), 'rejected order leaves no rows');
rollback;

-- 不可與點數疊加的優惠券，會員仍嘗試折抵點數。
begin;
select tests.seed();
insert into public.point_ledger(member_id, kind, points, reason) values (tests.id('member_a'), 'manual', 500, 'test seed');
insert into public.coupons(code, name, discount_amount, combinable_with_points, valid_from, valid_until)
values ('NOPOINTS1', '不可疊加點數券', 100, false, now() - interval '1 day', now() + interval '30 days');
select tests.login(tests.id('member_a'));
select tests.expect_error(
  $$select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 2), 'together', 'store_pickup', 'NOPOINTS1', 10, tests.id('bank'), null, null, null, null)$$,
  'COUPON_POINTS_NOT_COMBINABLE', 'non-combinable coupon rejects point redemption');
select tests.logout();
select tests.assert((select count(*) = 0 from public.orders), 'rejected order leaves no rows');
rollback;

-- 每人限用一次：同一會員第二次使用同一張券。
begin;
select tests.seed();
insert into public.coupons(code, name, discount_amount, valid_from, valid_until, per_member_limit)
values ('LIMIT1', '單次限用券', 100, now() - interval '1 day', now() + interval '30 days', 1);
select tests.login(tests.id('member_a'));
select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 1), 'together', 'store_pickup', 'LIMIT1', 0, tests.id('bank'), null, null, null, null);
select tests.expect_error(
  $$select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 1), 'together', 'store_pickup', 'LIMIT1', 0, tests.id('bank'), null, null, null, null)$$,
  'COUPON_MEMBER_LIMIT', 'coupon cannot be reused beyond its per-member limit');
select tests.logout();
select tests.assert((select count(*) = 1 from public.orders), 'second redemption attempt leaves no extra order');
rollback;

-- 總量上限：第一位會員用完後，另一位會員無法再使用。
begin;
select tests.seed();
insert into public.coupons(code, name, discount_amount, valid_from, valid_until, total_usage_limit, per_member_limit)
values ('TOTAL1', '總量限定券', 100, now() - interval '1 day', now() + interval '30 days', 1, 5);
select tests.login(tests.id('member_a'));
select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 1), 'together', 'store_pickup', 'TOTAL1', 0, tests.id('bank'), null, null, null, null);
select tests.login(tests.id('member_b'));
select tests.expect_error(
  $$select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 1), 'together', 'store_pickup', 'TOTAL1', 0, tests.id('bank'), null, null, null, null)$$,
  'COUPON_USAGE_LIMIT', 'coupon cannot be used beyond its total usage limit');
select tests.logout();
select tests.assert((select count(*) = 1 from public.orders where member_id = tests.id('member_a')), 'member A order stands');
select tests.assert((select count(*) = 0 from public.orders where member_id = tests.id('member_b')), 'member B redemption attempt leaves no order');
rollback;

-- 會員專屬券：coupon_members 只綁定會員 B，會員 A 不可使用。
begin;
select tests.seed();
create temp table t_coupon2 on commit drop as
  with c as (
    insert into public.coupons(code, name, discount_amount, valid_from, valid_until)
    values ('MEMBERONLY1', '會員專屬券', 100, now() - interval '1 day', now() + interval '30 days')
    returning id
  )
  select id from c;
insert into public.coupon_members(coupon_id, member_id) values ((select id from t_coupon2), tests.id('member_b'));
select tests.login(tests.id('member_a'));
select tests.expect_error(
  $$select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 1), 'together', 'store_pickup', 'MEMBERONLY1', 0, tests.id('bank'), null, null, null, null)$$,
  'COUPON_NOT_ELIGIBLE', 'a member-bound coupon rejects another member');
select tests.logout();
select tests.assert((select count(*) = 0 from public.orders), 'rejected order leaves no rows');
rollback;
