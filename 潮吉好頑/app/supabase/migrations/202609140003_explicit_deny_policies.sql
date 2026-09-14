-- 潮吉好頑：為 service-role-only 資料表建立明確 deny policies。
-- 這些表已在 202609140001 撤銷 anon／authenticated grants；
-- deny policy 讓 RLS 意圖明確，也避免未來誤開 grant 時意外暴露資料。

begin;

drop policy if exists "members view assigned coupons" on public.coupon_members;
drop policy if exists "members view own coupon redemptions" on public.coupon_redemptions;

create policy "deny api roles" on public.bank_accounts
  for all to anon, authenticated using (false) with check (false);
create policy "deny api roles" on public.birthday_coupon_issues
  for all to anon, authenticated using (false) with check (false);
create policy "deny api roles" on public.birthday_coupon_settings
  for all to anon, authenticated using (false) with check (false);
create policy "deny api roles" on public.coupon_products
  for all to anon, authenticated using (false) with check (false);
create policy "deny api roles" on public.coupon_members
  for all to anon, authenticated using (false) with check (false);
create policy "deny api roles" on public.coupon_redemptions
  for all to anon, authenticated using (false) with check (false);
create policy "deny api roles" on public.coupons
  for all to anon, authenticated using (false) with check (false);
create policy "deny api roles" on public.inventory_movements
  for all to anon, authenticated using (false) with check (false);
create policy "deny api roles" on public.inventory_reservations
  for all to anon, authenticated using (false) with check (false);
create policy "deny api roles" on public.line_low_stock_states
  for all to anon, authenticated using (false) with check (false);
create policy "deny api roles" on public.line_notification_logs
  for all to anon, authenticated using (false) with check (false);
create policy "deny api roles" on public.order_status_history
  for all to anon, authenticated using (false) with check (false);
create policy "deny api roles" on public.point_ledger
  for all to anon, authenticated using (false) with check (false);
create policy "deny api roles" on public.point_settings
  for all to anon, authenticated using (false) with check (false);
create policy "deny api roles" on public.shipping_settings_legacy
  for all to anon, authenticated using (false) with check (false);

commit;
