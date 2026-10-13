-- 建單通知補發查詢 missing_created_notifications()：只回仍待付款、且有預期收件人缺 created 通知紀錄的訂單；只有 service_role 能執行。
-- 測試視窗涵蓋同一交易內建立的訂單（current_timestamp 固定）。

-- 沒有任何通知紀錄的新訂單會被找到，並帶出會員的 LINE 收件人。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select tests.place_order(tests.id('variant_stock'), 1) as id;
grant select on t_order to public;
select tests.as_service();
create temp table t_found on commit drop as
  select * from public.missing_created_notifications(now() - interval '1 day', now() + interval '1 minute', true, array['111'], 10);
grant select on t_found to public;
select tests.logout();
select tests.assert((select count(*) = 1 from t_found, t_order where t_found.order_id = t_order.id), 'an order without any created notice is found');
select tests.assert((select line_user_id = (select line_user_id from public.profiles where id = tests.id('member_a')) from t_found), 'the member LINE recipient is returned');
rollback;

-- 每位收件人都有紀錄才算已通知；只缺 LINE 仍會被找到；LINE 停用時只看 Telegram。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select tests.place_order(tests.id('variant_stock'), 1) as id;
grant select on t_order to public;
select tests.as_service();
select public.claim_notification_delivery('telegram', 'created:' || (select id from t_order), '111', 'order_created', '{}'::jsonb, 120);
select tests.assert((select count(*) = 1 from public.missing_created_notifications(now() - interval '1 day', now() + interval '1 minute', true, array['111'], 10)),
                    'a Telegram record does not hide the missing LINE notice');
select tests.assert((select count(*) = 0 from public.missing_created_notifications(now() - interval '1 day', now() + interval '1 minute', false, array['111'], 10)),
                    'with LINE disabled the Telegram record is enough');
select tests.assert((select count(*) = 1 from public.missing_created_notifications(now() - interval '1 day', now() + interval '1 minute', false, array['111', '222'], 10)),
                    'a second Telegram admin without a record is still missing');
select public.claim_notification_delivery('line', 'created:' || (select id from t_order), (select line_user_id from public.profiles where id = tests.id('member_a')), 'order_created', '{}'::jsonb, 120);
select tests.assert((select count(*) = 0 from public.missing_created_notifications(now() - interval '1 day', now() + interval '1 minute', true, array['111'], 10)),
                    'an order recorded for every recipient is not returned');
rollback;

-- 已取消、宅配運費已通知、付款期限已過或不在時間範圍內的訂單都不回傳；沒有任何收件人時也不回傳。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_orders on commit drop as
  select n, tests.place_order(tests.id('variant_pre'), 1) as id from generate_series(1, 4) n;
grant select on t_orders to public;
select tests.logout();
update public.orders set status = 'cancelled', cancelled_at = now() where id = (select id from t_orders where n = 1);
update public.orders set shipping_fee_notified_at = now() where id = (select id from t_orders where n = 2);
update public.orders set payment_deadline = now() - interval '1 minute' where id = (select id from t_orders where n = 3);
select tests.as_service();
create temp table t_found on commit drop as
  select order_id from public.missing_created_notifications(now() - interval '1 day', now() + interval '1 minute', true, array['111'], 10);
grant select on t_found to public;
select tests.assert((select count(*) = 0 from public.missing_created_notifications(now() - interval '2 days', now() - interval '1 day', true, array['111'], 10)),
                    'orders outside the time window are not returned');
select tests.assert((select count(*) = 0 from public.missing_created_notifications(now() - interval '1 day', now() + interval '1 minute', false, '{}'::text[], 10)),
                    'no recipient means nothing is missing');
select tests.logout();
select tests.assert((select array_agg(order_id) from t_found) = array[(select id from t_orders where n = 4)], 'cancelled, fee-notified and expired orders are skipped');
rollback;

-- 依付款期限由近到遠回傳，並遵守筆數上限。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_orders on commit drop as
  select n, tests.place_order(tests.id('variant_stock'), 1) as id from generate_series(1, 3) n;
grant select on t_orders to public;
select tests.logout();
update public.orders set payment_deadline = now() + interval '10 minutes' where id = (select id from t_orders where n = 3);
select tests.as_service();
create temp table t_found on commit drop as
  select order_id from public.missing_created_notifications(now() - interval '1 day', now() + interval '1 minute', true, array['111'], 2);
grant select on t_found to public;
select tests.logout();
select tests.assert((select count(*) = 2 from t_found), 'the limit caps the result');
select tests.assert((select order_id from t_found limit 1) = (select id from t_orders where n = 3), 'the nearest payment deadline comes first');
rollback;

-- 會員與訪客不能執行（會看到其他會員的訂單與 LINE 收件人）。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
select tests.expect_error($$select * from public.missing_created_notifications(now() - interval '1 day', now(), true, array['111'], 10)$$, 'permission denied', 'members cannot list missing notices');
select tests.login(null);
select tests.expect_error($$select * from public.missing_created_notifications(now() - interval '1 day', now(), true, array['111'], 10)$$, 'permission denied', 'anon cannot list missing notices');
rollback;
