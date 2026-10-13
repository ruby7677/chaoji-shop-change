-- 建單冪等（202610130001）：同會員同 client_request_id 回傳原訂單，不重複保留庫存、不重複占用優惠券；
-- 內容不同拒絕、不同會員互不影響、未帶 key 沿用舊行為。
-- 限制：本 runner 每個案例只有一條連線，無法驗證兩條連線同時送出同 key；並發由 advisory lock＋唯一索引保證。

create or replace function tests.place_keyed(p_variant uuid, p_quantity integer, p_key uuid, p_coupon text default null, p_recipient text default null)
returns uuid
language sql
as $$
  select public.create_delivery_order(
    tests.order_items(p_variant, p_quantity), 'together',
    case when p_recipient is null then 'store_pickup' else 'home_delivery' end,
    p_coupon, 0, tests.id('bank'), null,
    case when p_recipient is null then null else '臺南市中西區民生路二段93號' end,
    p_recipient, case when p_recipient is null then null else '0912345678' end,
    null, null, null, null, p_key)
$$;
-- anon 也能呼叫這個 helper，未登入案例才會由建單入口本身的權限擋下。
grant execute on function tests.place_keyed(uuid, integer, uuid, text, text) to anon, authenticated;

-- 同 key 重送：回傳同一筆訂單，只有一筆訂單與一筆保留量。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_ids on commit drop as
  select tests.place_keyed(tests.id('variant_stock'), 2, '11111111-1111-4111-8111-111111111111') as first_id,
         tests.place_keyed(tests.id('variant_stock'), 2, '11111111-1111-4111-8111-111111111111') as second_id;
select tests.logout();
select tests.assert((select first_id = second_id from t_ids), 'retrying the same request returns the original order');
select tests.assert((select count(*) = 1 from public.orders), 'the retry creates no second order');
select tests.assert((select count(*) = 1 and sum(quantity) = 2 from public.inventory_reservations), 'the retry reserves stock only once');
select tests.assert(tests.available(tests.id('variant_stock')) = 3, 'available stock drops only once');
rollback;

-- 重送不改寫原訂單（收件資訊與更新時間不變）。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_first on commit drop as
  select tests.place_keyed(tests.id('variant_stock'), 1, '22222222-2222-4222-8222-222222222222', null, '王小明') as id;
select tests.logout();
update public.orders set shipping_recipient_name = '客服改過', updated_at = '2026-01-01 00:00+08' where id = (select id from t_first);
select tests.login(tests.id('member_a'));
select tests.place_keyed(tests.id('variant_stock'), 1, '22222222-2222-4222-8222-222222222222', null, '王小明');
select tests.logout();
select tests.assert((select shipping_recipient_name = '客服改過' and updated_at = '2026-01-01 00:00+08'
                       from public.orders where id = (select id from t_first)),
                    'a retry does not rewrite the recipient or touch the original order');
rollback;

-- 同 key 不同內容：拒絕，不建新單。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
select tests.place_keyed(tests.id('variant_stock'), 1, '33333333-3333-4333-8333-333333333333');
select tests.expect_error(
  $$select tests.place_keyed(tests.id('variant_stock'), 2, '33333333-3333-4333-8333-333333333333')$$,
  'CLIENT_REQUEST_CONFLICT', 'the same key with a different cart is rejected');
select tests.logout();
select tests.assert((select count(*) = 1 from public.orders), 'a conflicting request leaves only the first order');
rollback;

-- 不同會員使用相同 key：各自建單。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
select tests.place_keyed(tests.id('variant_stock'), 1, '44444444-4444-4444-8444-444444444444');
select tests.login(tests.id('member_b'));
select tests.place_keyed(tests.id('variant_stock'), 1, '44444444-4444-4444-8444-444444444444');
select tests.logout();
select tests.assert((select count(*) = 2 and count(distinct member_id) = 2 from public.orders), 'keys are scoped to each member');
rollback;

-- 原單已取消：仍回傳原訂單，不重新保留。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_first on commit drop as
  select tests.place_keyed(tests.id('variant_stock'), 1, '55555555-5555-4555-8555-555555555555') as id;
select tests.logout();
select tests.as_service();
select public.admin_transition_order(tests.id('admin'), (select id from t_first), 'cancelled', '測試取消', 0);
select tests.login(tests.id('member_a'));
create temp table t_retry on commit drop as
  select tests.place_keyed(tests.id('variant_stock'), 1, '55555555-5555-4555-8555-555555555555') as id;
select tests.logout();
select tests.assert((select r.id = f.id from t_retry r, t_first f), 'a cancelled original is still returned');
select tests.assert((select count(*) = 1 from public.orders), 'no new order after cancellation');
select tests.assert((select count(*) = 0 from public.inventory_reservations where released_at is null), 'the retry does not reserve stock again');
rollback;

-- 第一次已買光庫存：重送仍找回原單，不被 INSUFFICIENT_STOCK 擋下。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_ids on commit drop as
  select tests.place_keyed(tests.id('variant_stock'), 5, '66666666-6666-4666-8666-666666666666') as first_id,
         tests.place_keyed(tests.id('variant_stock'), 5, '66666666-6666-4666-8666-666666666666') as second_id;
select tests.logout();
select tests.assert((select first_id = second_id from t_ids), 'a retry after selling out returns the original order');
rollback;

-- 單次限用券：重送找回原單，只占用一次。
begin;
select tests.seed();
insert into public.coupons(code, name, discount_amount, valid_from, valid_until, per_member_limit)
values ('ONCE1', '單次限用券', 100, now() - interval '1 day', now() + interval '30 days', 1);
select tests.login(tests.id('member_a'));
create temp table t_ids on commit drop as
  select tests.place_keyed(tests.id('variant_stock'), 1, '77777777-7777-4777-8777-777777777777', 'once1') as first_id,
         tests.place_keyed(tests.id('variant_stock'), 1, '77777777-7777-4777-8777-777777777777', ' ONCE1 ') as second_id;
select tests.logout();
select tests.assert((select first_id = second_id from t_ids), 'a retry with the same coupon returns the original order');
select tests.assert((select count(*) = 1 from public.coupon_redemptions), 'the coupon is redeemed only once');
rollback;

-- 未帶 key：沿用舊行為，兩次各建一筆。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
select tests.place_keyed(tests.id('variant_stock'), 1, null);
select tests.place_keyed(tests.id('variant_stock'), 1, null);
select tests.logout();
select tests.assert((select count(*) = 2 and count(client_request_id) = 0 from public.orders), 'without a key every call creates an order');
rollback;

-- 未登入不可呼叫。
begin;
select tests.seed();
select tests.login(null);
select tests.expect_error(
  $$select tests.place_keyed(tests.id('variant_stock'), 1, '88888888-8888-4888-8888-888888888888')$$,
  'permission denied', 'anon cannot call the idempotent order entry');
select tests.logout();
rollback;
