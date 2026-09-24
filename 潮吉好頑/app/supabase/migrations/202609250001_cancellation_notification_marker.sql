-- 潮吉好頑：已取消訂單通知掃描標記。
-- Worker 每小時掃描已取消訂單補送通知；原本每次都走遍全部歷史取消訂單，
-- 並對每位收件人重新 claim（即使已送達也會寫入 updated_at），成本隨訂單數無限成長。
-- 改為：通知已交給 claim／重試狀態機後寫入 cancellation_notified_at，
-- 之後的掃描只處理尚未標記的訂單；失敗通知仍由每 5 分鐘的重試 cron 負責。

begin;

alter table public.orders
  add column if not exists cancellation_notified_at timestamptz;

comment on column public.orders.cancellation_notified_at is
  '取消通知已交給通知 claim 狀態機的時間；僅 Worker service_role 寫入，NULL 代表每小時掃描仍需處理';

-- 既有取消訂單已由舊版每小時全量掃描處理過。保留最近 1 天的訂單給新版掃描
-- 再確認一次（claim 以 event_key＋recipient 去重，不會重複發送）。
update public.orders
   set cancellation_notified_at = now()
 where status = 'cancelled'
   and cancelled_at is not null
   and cancelled_at < now() - interval '1 day'
   and cancellation_notified_at is null;

create index if not exists orders_cancellation_notification_pending_idx
  on public.orders (cancelled_at, id)
  where status = 'cancelled' and cancellation_notified_at is null;

commit;
