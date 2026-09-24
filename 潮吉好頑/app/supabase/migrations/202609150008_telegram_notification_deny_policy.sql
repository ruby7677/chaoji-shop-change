-- 潮吉好頑：Telegram 通知紀錄明確拒絕 anon／authenticated，僅供 Worker service_role 使用。

begin;

drop policy if exists "deny api roles" on public.telegram_notification_logs;
create policy "deny api roles"
  on public.telegram_notification_logs
  for all to anon, authenticated
  using (false)
  with check (false);

commit;
