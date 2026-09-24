-- 潮吉好頑：Telegram 管理員通知去重與結果紀錄。
-- Bot token 與 chat ID 僅放在 Cloudflare secrets，不儲存在資料庫。

begin;

create table if not exists public.telegram_notification_logs (
  id uuid primary key default gen_random_uuid(),
  event_key text not null,
  recipient_id text not null,
  event_type text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  error_message text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (event_key, recipient_id)
);

alter table public.telegram_notification_logs enable row level security;
revoke all on table public.telegram_notification_logs from public, anon, authenticated;
grant all on table public.telegram_notification_logs to service_role;

comment on table public.telegram_notification_logs is
  'Telegram 管理員通知的去重、成功與失敗紀錄';

commit;
