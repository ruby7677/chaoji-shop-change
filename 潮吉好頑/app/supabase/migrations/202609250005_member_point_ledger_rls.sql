-- 潮吉好頑：會員以自己的 JWT 讀取點數紀錄（RLS），不再由 Worker 以 service_role＋手寫 member_id 條件代讀。
-- 只開放本人列與前台需要的欄位；actor_id（操作的管理員）不公開，寫入仍只能經由 SECURITY DEFINER 函式。
-- 既有 "deny api roles"（ALL，false）保留：permissive policy 以 OR 合併，本人 SELECT 由新 policy 放行，
-- INSERT／UPDATE／DELETE 仍無任何 policy 與權限。

begin;

drop policy if exists "members view own point ledger" on public.point_ledger;
create policy "members view own point ledger" on public.point_ledger
  for select to authenticated
  using (member_id = (select auth.uid()));

revoke all on table public.point_ledger from anon, authenticated;
grant select (id, member_id, order_id, kind, points, reason, created_at) on table public.point_ledger to authenticated;

commit;
