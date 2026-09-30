-- 建立訂單：金額與保留量、庫存不足與保留量衝突時整筆回滾、建單前置條件與登入要求。

-- 正常建單：金額由資料庫計算，建立一筆保留量，可售數量隨之減少。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select tests.place_order(tests.id('variant_stock'), 2) as id;
select tests.logout();
select tests.assert((select status = 'pending_payment' and subtotal = 2000 and amount_due = 2000 and deposit_due = 2000
                            and member_id = tests.id('member_a') and bank_account_id = tests.id('bank')
                       from public.orders where id = (select id from t_order)),
                    'in-stock order totals are computed by the database');
select tests.assert((select payment_deadline = now() + interval '24 hours' from public.orders where id = (select id from t_order)),
                    'in-stock bank transfer order has a 24 hour payment deadline');
select tests.assert((select order_number like 'CJ-' || to_char(now() at time zone 'Asia/Taipei', 'YYMMDD-HH24MISS') || '-____'
                       from public.orders where id = (select id from t_order)),
                    'the order number carries Taiwan date and time');
select tests.assert(current_setting('TimeZone') <> 'Asia/Taipei' or current_setting('TimeZone') = (select setting from pg_settings where name = 'TimeZone'),
                    'placing an order does not change the session time zone');
select tests.assert((select count(*) = 1 and sum(quantity) = 2 from public.inventory_reservations
                      where order_id = (select id from t_order) and released_at is null),
                    'order reserves the ordered quantity');
select tests.assert(tests.available(tests.id('variant_stock')) = 3, 'available stock drops from 5 to 3');
select tests.assert((select stock_on_hand = 5 from public.product_variants where id = tests.id('variant_stock')),
                    'physical stock is not deducted until payment is confirmed');
rollback;

-- 預購：訂金 50%、付款期限 2 小時。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select tests.place_order(tests.id('variant_pre'), 1) as id;
select tests.logout();
select tests.assert((select amount_due = 2000 and deposit_due = 1000 and payment_deadline = now() + interval '2 hours'
                       from public.orders where id = (select id from t_order)),
                    'preorder deposit is 50% with a 2 hour deadline');
rollback;

-- 庫存不足：整筆失敗，不留下訂單、明細或保留量。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
select tests.expect_error($$select tests.place_order(tests.id('variant_stock'), 6)$$, 'INSUFFICIENT_STOCK', 'ordering more than stock fails');
select tests.logout();
select tests.assert((select count(*) = 0 from public.orders), 'failed order leaves no order row');
select tests.assert((select count(*) = 0 from public.inventory_reservations), 'failed order leaves no reservation');
rollback;

-- 保留量衝突：A 保留 4 件後，B 只能買到剩下的 1 件。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
select tests.place_order(tests.id('variant_stock'), 4);
select tests.login(tests.id('member_b'));
select tests.expect_error($$select tests.place_order(tests.id('variant_stock'), 2)$$, 'INSUFFICIENT_STOCK', 'reserved stock cannot be sold twice');
select tests.place_order(tests.id('variant_stock'), 1);
select tests.logout();
select tests.assert(tests.available(tests.id('variant_stock')) = 0, 'all stock is reserved exactly once');
select tests.assert((select count(*) = 1 from public.orders where member_id = tests.id('member_b')), 'B keeps only the successful order');
rollback;

-- 現貨與預購不可混在同一筆，且不留下部分資料。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
select tests.expect_error(
  $$select public.create_delivery_order(
      jsonb_build_array(jsonb_build_object('variant_id', tests.id('variant_stock'), 'quantity', 1),
                        jsonb_build_object('variant_id', tests.id('variant_pre'), 'quantity', 1)),
      'together', 'store_pickup', null, 0, tests.id('bank'), null, null, null, null)$$,
  'MIXED_ORDER_NOT_ALLOWED', 'mixed stock and preorder order is rejected');
select tests.logout();
select tests.assert((select count(*) = 0 from public.orders), 'mixed order leaves no rows');
rollback;

-- 同一規格重複出現在購物車：逐行檢查庫存時兩行各自都過，由唯一約束擋下整筆，不能拆行超賣。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
select tests.expect_error(
  $$select public.create_delivery_order(
      jsonb_build_array(jsonb_build_object('variant_id', tests.id('variant_stock'), 'quantity', 3),
                        jsonb_build_object('variant_id', tests.id('variant_stock'), 'quantity', 3)),
      'together', 'store_pickup', null, 0, tests.id('bank'), null, null, null, null)$$,
  'order_items_one_variant_per_order', 'duplicate lines cannot oversell');
select tests.logout();
select tests.assert((select count(*) = 0 from public.orders), 'duplicate-line order leaves no rows');
rollback;

-- 前置條件：未登入、未加 LINE 好友、資料不完整、到店取貨不可選到店付款。
begin;
select tests.seed();
select tests.login(null);
select tests.expect_error($$select tests.place_order(tests.id('variant_stock'), 1)$$, 'permission denied', 'anon cannot execute create_delivery_order');
select tests.logout();
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select tests.expect_error($$select tests.place_order(tests.id('variant_stock'), 1)$$, 'LOGIN_REQUIRED', 'JWT without a user is rejected');
select tests.login(tests.id('member_no_line'));
select tests.expect_error($$select tests.place_order(tests.id('variant_stock'), 1)$$, 'LINE_FRIEND_REQUIRED', 'member must be a verified LINE friend');
select tests.logout();
update public.profiles set full_name = null, phone = null where id = tests.id('member_b');
select tests.login(tests.id('member_b'));
select tests.expect_error($$select tests.place_order(tests.id('variant_stock'), 1)$$, 'PROFILE_INCOMPLETE', 'profile must be complete');
select tests.login(tests.id('member_a'));
select tests.expect_error(
  $$select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 1), 'together', 'store_pickup', null, 0, null, null, null, null, null)$$,
  'STORE_PAYMENT_BANK_TRANSFER_ONLY', 'store pickup must be paid by bank transfer');
select tests.expect_error(
  $$select public.create_delivery_order(tests.order_items(tests.id('variant_stock'), 1), 'together', 'home_delivery', null, 0, tests.id('bank'), null, '台南市', '王小明', '12345')$$,
  'SHIPPING_PHONE_REQUIRED', 'home delivery needs a valid mobile number');
select tests.logout();
select tests.assert((select count(*) = 0 from public.orders), 'rejected orders leave no rows');
rollback;

-- 未上架商品不可下單。
begin;
select tests.seed();
update public.product_variants set is_published = false where id = tests.id('variant_stock');
select tests.login(tests.id('member_a'));
select tests.expect_error($$select tests.place_order(tests.id('variant_stock'), 1)$$, 'PRODUCT_NOT_FOUND', 'unpublished variant cannot be ordered');
rollback;

-- 待處理訂單上限：同一會員最多 5 筆待付款／待確認。
begin;
select tests.seed();
update public.product_variants set stock_on_hand = 100 where id = tests.id('variant_stock');
select tests.login(tests.id('member_a'));
select tests.place_order(tests.id('variant_stock'), 1) from generate_series(1, 5);
select tests.expect_error($$select tests.place_order(tests.id('variant_stock'), 1)$$, 'PENDING_ORDER_LIMIT', 'sixth pending order is rejected');
select tests.logout();
select tests.assert((select count(*) = 5 from public.orders where member_id = tests.id('member_a')), 'exactly five pending orders exist');
rollback;

-- 限購：同一會員累計購買數量不可超過商品限購。
begin;
select tests.seed();
update public.products set purchase_limit = 2 where id = tests.id('product_stock');
select tests.login(tests.id('member_a'));
select tests.place_order(tests.id('variant_stock'), 2);
select tests.expect_error($$select tests.place_order(tests.id('variant_stock'), 1)$$, 'PURCHASE_LIMIT_EXCEEDED', 'purchase limit counts earlier orders');
rollback;

-- 賣貨便現貨：以賣貨便外部付款（本站無銀行帳戶）建立待確認訂單，本站不收款，
-- deposit_due = 0，付款期限維持 3 個月，供管理員核對賣貨便外部訂單後再確認。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select public.create_delivery_order(
    tests.order_items(tests.id('variant_stock'), 1), 'together', 'seller_delivery', null, 0,
    null, null, null, null, null) as id;
select tests.logout();
select tests.assert((select status = 'pending_payment' and subtotal = 1000 and amount_due = 1000 and deposit_due = 0
                            and bank_account_id is null and payment_last_five is null and delivery_method = 'seller_delivery'
                       from public.orders where id = (select id from t_order)),
                    'seller-delivery store-payment order has zero deposit and no bank account');
-- 「3 個月」以台灣時間的日曆月份計算（函式層級 timezone = Asia/Taipei）；測試連線是 UTC，月底／月初跨日時直接在 UTC 加月份會差一天。
select tests.assert((select payment_deadline = ((now() at time zone 'Asia/Taipei') + interval '3 months') at time zone 'Asia/Taipei' from public.orders where id = (select id from t_order)),
                    'seller-delivery store-payment order keeps a 3 month payment deadline');
rollback;

-- 賣貨便預購：先在本站以匯款支付訂金（非賣貨便外部付款），訂金 50%、付款期限 2 小時。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select public.create_delivery_order(
    tests.order_items(tests.id('variant_pre'), 1), 'together', 'seller_delivery', null, 0,
    tests.id('bank'), null, null, null, null) as id;
select tests.logout();
select tests.assert((select amount_due = 2000 and deposit_due = 1000 and bank_account_id = tests.id('bank')
                            and delivery_method = 'seller_delivery'
                       from public.orders where id = (select id from t_order)),
                    'seller-delivery preorder bank-transfer order has a 50% deposit');
select tests.assert((select payment_deadline = now() + interval '2 hours' from public.orders where id = (select id from t_order)),
                    'seller-delivery preorder bank-transfer order has a 2 hour payment deadline');
rollback;

-- 到店支付（無銀行帳戶）僅限賣貨便；宅配一律匯款，其餘一律拒絕。
-- 賣貨便同時帶「到店支付」標記與銀行帳戶的組合無法在此 RPC 表達：p_bank_account_id 為 null
-- 即代表到店支付，本身就與「附上銀行帳戶」互斥，該組合的檢查屬於 Worker 請求驗證層，不在此測試。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
select tests.expect_error(
  $$select public.create_delivery_order(
      tests.order_items(tests.id('variant_stock'), 1), 'together', 'home_delivery', null, 0,
      null, null, '台南市', '王小明', '0912345678')$$,
  'STORE_PAYMENT_BANK_TRANSFER_ONLY', 'home delivery must be paid by bank transfer');
select tests.logout();
select tests.assert((select count(*) = 0 from public.orders), 'rejected home-delivery store-payment order leaves no rows');
rollback;
