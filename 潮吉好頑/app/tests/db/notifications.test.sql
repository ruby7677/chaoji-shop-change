-- 通知送達狀態機（notification_deliveries）：claim／complete／重試／lease 回收／channel 隔離／後台列表與重新排入／保留期限。
-- 以 Worker 的 service_role 身分呼叫；外部 LINE／Telegram API 不在資料庫測試範圍。
-- 注意：同一交易內 current_timestamp 固定，到期情境以直接改寫 next_retry_at／lease_expires_at 模擬。

-- claim → sent：lease 內不能重複 claim、舊 token 與錯誤 channel 不能完成；已送出的通知不再 claim、也不再寫入。
begin;
select tests.seed();
select tests.as_service();
create temp table t_claim on commit drop as
  select public.claim_notification_delivery('line', 'created:k1', 'U-recipient-1', 'order_created', '{"v":1}'::jsonb, 120) as c;
select tests.assert((select (c->>'claimed')::boolean and c->>'status' = 'processing' and (c->>'attempt_count')::int = 1 from t_claim),
                    'first claim wins and starts processing');
select tests.assert((select not (public.claim_notification_delivery('line', 'created:k1', 'U-recipient-1', 'order_created', '{"v":2}'::jsonb, 120)->>'claimed')::boolean),
                    'a second claim during the lease does not win');
select tests.assert((select not public.complete_notification_delivery('line', (c->>'id')::uuid, gen_random_uuid(), true) from t_claim),
                    'a stale claim token cannot complete');
select tests.assert((select not public.complete_notification_delivery('telegram', (c->>'id')::uuid, (c->>'claim_token')::uuid, true) from t_claim),
                    'completing through the wrong channel does nothing');
select tests.assert((select public.complete_notification_delivery('line', (c->>'id')::uuid, (c->>'claim_token')::uuid, true, 200) from t_claim),
                    'the current claim token completes the delivery');
create temp table t_before on commit drop as select ctid as row_version from public.notification_deliveries where event_key = 'created:k1';
create temp table t_again on commit drop as
  select public.claim_notification_delivery('line', 'created:k1', 'U-recipient-1', 'order_created', '{"v":3}'::jsonb, 120) as c;
select tests.assert((select not (c->>'claimed')::boolean and c->>'status' = 'sent' and c->'payload' = '{"v":2}'::jsonb from t_again),
                    'a sent delivery is never claimed again and keeps its payload');
select tests.assert((select d.ctid = b.row_version from public.notification_deliveries d, t_before b where d.event_key = 'created:k1'),
                    'claiming a sent delivery does not rewrite the row');
rollback;

-- 暫時性失敗：排入 next_retry_at，到期前不會被 claim_due 領取；到期後只由同 channel 領取並重新計次。
begin;
select tests.seed();
select tests.as_service();
create temp table t_claim on commit drop as
  select public.claim_notification_delivery('telegram', 'payment_reported:k2', '123456789', 'order_payment_reported', '{}'::jsonb, 120) as c;
select tests.assert((select public.complete_notification_delivery('telegram', (c->>'id')::uuid, (c->>'claim_token')::uuid, false, 429, 'rate limited', true, 60) from t_claim),
                    'a transient failure is recorded');
select tests.assert((select status = 'failed' and failure_kind = 'transient' and next_retry_at > current_timestamp and last_status_code = 429
                       from public.notification_deliveries where event_key = 'payment_reported:k2'), 'a transient failure schedules a retry');
select tests.assert((select count(*) = 0 from public.claim_due_notification_deliveries('telegram', 25, 120)), 'a retry is not claimed before it is due');
update public.notification_deliveries set next_retry_at = current_timestamp - interval '1 second' where event_key = 'payment_reported:k2';
select tests.assert((select count(*) = 0 from public.claim_due_notification_deliveries('line', 25, 120)), 'due retries are claimed per channel');
create temp table t_due on commit drop as select d from public.claim_due_notification_deliveries('telegram', 25, 120) d;
select tests.assert((select count(*) = 1 and bool_and(d->>'status' = 'processing' and (d->>'attempt_count')::int = 2 and d->>'event_key' = 'payment_reported:k2'
                                                      and d ? 'recipient_id' and d ? 'event_type' and d ? 'payload') from t_due),
                    'the due retry is claimed with a fresh attempt and the fields the Worker needs');
select tests.assert((select public.complete_notification_delivery('telegram', (d->>'id')::uuid, (d->>'claim_token')::uuid, true) from t_due),
                    'the retried delivery completes');
rollback;

-- lease 過期：claim_due 回收處理中的通知並換發新 token；舊 token 不能再完成。
begin;
select tests.seed();
select tests.as_service();
create temp table t_claim on commit drop as
  select public.claim_notification_delivery('line', 'created:k3', 'U-recipient-3', 'order_created', '{}'::jsonb, 120) as c;
update public.notification_deliveries set lease_expires_at = current_timestamp - interval '1 second' where event_key = 'created:k3';
create temp table t_due on commit drop as select d from public.claim_due_notification_deliveries('line', 25, 120) d;
select tests.assert((select count(*) = 1 and bool_and(d->>'claim_token' <> (select c->>'claim_token' from t_claim)) from t_due),
                    'an expired lease is reclaimed with a new token');
select tests.assert((select not public.complete_notification_delivery('line', (c->>'id')::uuid, (c->>'claim_token')::uuid, true) from t_claim),
                    'the fenced-off attempt cannot complete');
select tests.assert((select public.complete_notification_delivery('line', (d->>'id')::uuid, (d->>'claim_token')::uuid, true) from t_due),
                    'the reclaiming attempt completes');
rollback;

-- channel 隔離與參數檢查：同一 event／收件人在 LINE 與 Telegram 各自一列；未知 channel 一律拒絕。
begin;
select tests.seed();
select tests.as_service();
select public.claim_notification_delivery('line', 'shared:k4', 'same-recipient', 'test', '{}'::jsonb, 120);
select public.claim_notification_delivery('telegram', 'shared:k4', 'same-recipient', 'test', '{}'::jsonb, 120);
select tests.assert((select count(*) = 2 and count(distinct channel) = 2 from public.notification_deliveries where event_key = 'shared:k4'),
                    'the same event and recipient are tracked separately per channel');
select tests.expect_error($$select public.claim_notification_delivery('email', 'x', 'y', 'z', '{}'::jsonb, 120)$$, 'INVALID_NOTIFICATION_CHANNEL', 'claim rejects unknown channels');
select tests.expect_error($$select public.claim_due_notification_deliveries('email', 25, 120)$$, 'INVALID_NOTIFICATION_CHANNEL', 'claim_due rejects unknown channels');
select tests.expect_error($$select public.complete_notification_delivery('email', gen_random_uuid(), gen_random_uuid(), true)$$, 'INVALID_NOTIFICATION_CHANNEL', 'complete rejects unknown channels');
select tests.expect_error($$select public.claim_notification_delivery('line', ' ', 'y', 'z', '{}'::jsonb, 120)$$, 'INVALID_NOTIFICATION_CLAIM', 'claim requires an event key');
rollback;

-- 永久失敗不自動重試；後台只能重新排入 failed 通知並留下稽核，排入後由 claim_due 領取。
begin;
select tests.seed();
select tests.as_service();
create temp table t_claim on commit drop as
  select public.claim_notification_delivery('line', 'created:k5', 'U-recipient-5', 'order_created', '{}'::jsonb, 120) as c;
select public.complete_notification_delivery('line', (c->>'id')::uuid, (c->>'claim_token')::uuid, false, 400, 'invalid message', false) from t_claim;
select tests.assert((select status = 'failed' and failure_kind = 'permanent' and next_retry_at is null from public.notification_deliveries where event_key = 'created:k5'),
                    'a permanent failure is not scheduled');
update public.notification_deliveries set updated_at = current_timestamp - interval '1 day' where event_key = 'created:k5';
select tests.assert((select count(*) = 0 from public.claim_due_notification_deliveries('line', 25, 120)), 'a permanent failure is never retried automatically');
select tests.expect_error(format($$select public.admin_requeue_notification_delivery(%L, 'line', %L)$$, tests.id('member_a'), (select c->>'id' from t_claim)),
                          'ADMIN_REQUIRED', 'only admins can requeue');
select tests.expect_error(format($$select public.admin_requeue_notification_delivery(%L, 'telegram', %L)$$, tests.id('admin'), (select c->>'id' from t_claim)),
                          'NOTIFICATION_NOT_FOUND', 'requeue looks the delivery up within its channel');
select tests.assert((select (public.admin_requeue_notification_delivery(tests.id('admin'), 'line', (c->>'id')::uuid)->>'status') = 'failed' from t_claim),
                    'an admin requeues the failed delivery');
select tests.assert((select count(*) = 1 from public.audit_logs where action = 'retry' and resource = 'notification_delivery'
                       and target = 'line:' || (select c->>'id' from t_claim)), 'the requeue is audited');
create temp table t_due on commit drop as select d from public.claim_due_notification_deliveries('line', 25, 120) d;
select tests.assert((select count(*) = 1 from t_due), 'the requeued delivery is claimed by the retry job');
select public.complete_notification_delivery('line', (d->>'id')::uuid, (d->>'claim_token')::uuid, true) from t_due;
select tests.expect_error(format($$select public.admin_requeue_notification_delivery(%L, 'line', %L)$$, tests.id('admin'), (select c->>'id' from t_claim)),
                          'NOTIFICATION_REQUEUE_NOT_ALLOWED', 'a sent delivery cannot be requeued');
rollback;

-- 後台列表：遮罩收件人、LINE 對應會員姓名、訂單事件帶訂單編號，不回傳 payload／token／完整收件人；可依 channel／狀態篩選與分頁。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
create temp table t_order on commit drop as select tests.place_order(tests.id('variant_stock'), 1) as id;
grant select on t_order to public;
select tests.as_service();
select public.claim_notification_delivery('line', 'created:' || (select id from t_order), (select line_user_id from public.profiles where id = tests.id('member_a')),
                                          'order_created', '{"secret":"payload"}'::jsonb, 120);
select public.claim_notification_delivery('telegram', 'created:' || (select id from t_order), '987654321', 'order_created', '{}'::jsonb, 120);
select public.claim_notification_delivery('telegram', 'low-stock:2026-09-24:x', '987654321', 'low_stock', '{}'::jsonb, 120);
create temp table t_list on commit drop as select public.admin_list_notification_deliveries(tests.id('admin'), 'all', 'all', 0, 50) as r;
select tests.assert((select jsonb_array_length(r->'items') = 3 and not (r->'pagination'->>'hasMore')::boolean from t_list), 'all deliveries are listed');
select tests.assert((select bool_and(not (item ? 'payload') and not (item ? 'claim_token') and not (item ? 'recipient_id') and item->>'recipient_hint' like '%*%')
                       from t_list, jsonb_array_elements(r->'items') item), 'the list masks recipients and hides payloads and tokens');
select tests.assert((select item->>'recipient_name' = '測試 member_a' and item->>'order_number' = (select order_number from public.orders where id = (select id from t_order))
                       from t_list, jsonb_array_elements(r->'items') item where item->>'channel' = 'line'), 'LINE rows show the member name and order number');
select tests.assert((select count(*) = 2 and bool_and(item->>'recipient_name' = '管理員 Telegram')
                       and count(item->>'order_number') = 1
                       from t_list, jsonb_array_elements(r->'items') item where item->>'channel' = 'telegram'), 'Telegram rows show the admin label; only order events carry an order number');
select tests.assert((select jsonb_array_length(public.admin_list_notification_deliveries(tests.id('admin'), 'telegram', 'processing', 0, 50)->'items') = 2),
                    'the list filters by channel and status');
select tests.assert((select (public.admin_list_notification_deliveries(tests.id('admin'), 'all', 'all', 0, 2)->'pagination'->>'hasMore')::boolean),
                    'the list reports more pages');
select tests.expect_error(format($$select public.admin_list_notification_deliveries(%L, 'all', 'all', 0, 50)$$, tests.id('member_a')), 'ADMIN_REQUIRED', 'only admins can list deliveries');
select tests.expect_error(format($$select public.admin_list_notification_deliveries(%L, 'email', 'all', 0, 50)$$, tests.id('admin')), 'INVALID_NOTIFICATION_CHANNEL', 'the list rejects unknown channels');
rollback;

-- 權限：會員與訪客不能呼叫通知函式或讀寫通知表；保留期限清理只給排程（擁有者）執行，service_role 也不行。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
select tests.expect_error($$select public.claim_notification_delivery('line', 'x', 'y', 'z', '{}'::jsonb, 120)$$, 'permission denied', 'members cannot claim notifications');
select tests.expect_error($$select public.complete_notification_delivery('line', gen_random_uuid(), gen_random_uuid(), true)$$, 'permission denied', 'members cannot complete notifications');
select tests.expect_error($$select public.claim_due_notification_deliveries('line', 25, 120)$$, 'permission denied', 'members cannot claim due notifications');
select tests.expect_error(format($$select public.admin_list_notification_deliveries(%L, 'all', 'all', 0, 50)$$, tests.id('admin')), 'permission denied', 'members cannot call the admin list');
select tests.expect_error($$select public.purge_notification_deliveries(180)$$, 'permission denied', 'members cannot purge');
select tests.expect_error($$select count(*) from public.notification_deliveries$$, 'permission denied', 'members cannot read deliveries');
select tests.login(null);
select tests.expect_error($$select public.claim_notification_delivery('line', 'x', 'y', 'z', '{}'::jsonb, 120)$$, 'permission denied', 'anon cannot claim notifications');
select tests.expect_error($$insert into public.notification_deliveries(channel, event_key, recipient_id, event_type) values ('line', 'x', 'y', 'z')$$,
                          'permission denied', 'anon cannot write deliveries');
select tests.as_service();
select tests.expect_error($$select public.purge_notification_deliveries(180)$$, 'permission denied', 'the Worker cannot purge');
rollback;

-- 保留期限：只刪超過天數的 sent 與不再重試的 failed；排程中的 failed、處理中與新紀錄保留；天數下限 30。
begin;
select tests.seed();
insert into public.notification_deliveries(channel, event_key, recipient_id, event_type, status, failure_kind, next_retry_at, updated_at) values
  ('line',     'old-sent',            'r', 't', 'sent',       null,        null,                       now() - interval '200 days'),
  ('telegram', 'old-failed-final',    'r', 't', 'failed',     'permanent', null,                       now() - interval '200 days'),
  ('line',     'old-failed-retrying', 'r', 't', 'failed',     'transient', now() + interval '1 minute', now() - interval '200 days'),
  ('line',     'old-processing',      'r', 't', 'processing', null,        null,                       now() - interval '200 days'),
  ('telegram', 'recent-sent',         'r', 't', 'sent',       null,        null,                       now() - interval '20 days');
select tests.assert(public.purge_notification_deliveries(1) = 2, 'purge deletes old sent and final failed rows, with a 30-day floor');
select tests.assert((select array_agg(event_key order by event_key) = array['old-failed-retrying', 'old-processing', 'recent-sent'] from public.notification_deliveries),
                    'scheduled retries, in-flight and recent rows are kept');
select tests.assert((select count(*) = 1 from cron.job where jobname = 'chaoji-purge-notification-deliveries'), 'the purge runs daily via pg_cron');
rollback;
