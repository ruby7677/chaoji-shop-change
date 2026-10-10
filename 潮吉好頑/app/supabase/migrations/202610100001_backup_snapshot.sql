-- 潮吉好頑：每週備份用的一致性快照（Worker src/database-backup.ts 每週呼叫一次）。
-- 單一 SQL 敘述在同一個快照內讀出所有營運資料表：分表分頁讀取時，期間成立的訂單可能只有明細沒有訂單、
-- 或因新列插入已讀範圍造成分頁重複／遺漏，還原時違反外鍵。
-- 只回傳資料、不寫入；security invoker，僅 service_role 可執行（service_role 本來就能讀這些表）。
-- 刻意不含：liff_session_vault（登入工作階段密文）、member_cart_items、line_low_stock_states、notification_deliveries；
-- auth.users 不在 public schema，還原後會員需重新以 LINE 登入。

begin;

create or replace function public.backup_snapshot()
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select jsonb_build_object(
    'taken_at', now(),
    'tables', jsonb_build_object(
      'categories', coalesce((select jsonb_agg(t order by t.id) from public.categories t), '[]'::jsonb),
      'products', coalesce((select jsonb_agg(t order by t.id) from public.products t), '[]'::jsonb),
      'product_variants', coalesce((select jsonb_agg(t order by t.id) from public.product_variants t), '[]'::jsonb),
      'product_images', coalesce((select jsonb_agg(t order by t.id) from public.product_images t), '[]'::jsonb),
      'profiles', coalesce((select jsonb_agg(t order by t.id) from public.profiles t), '[]'::jsonb),
      'bank_accounts', coalesce((select jsonb_agg(t order by t.id) from public.bank_accounts t), '[]'::jsonb),
      'point_settings', coalesce((select jsonb_agg(t order by t.id) from public.point_settings t), '[]'::jsonb),
      'birthday_coupon_settings', coalesce((select jsonb_agg(t order by t.id) from public.birthday_coupon_settings t), '[]'::jsonb),
      'coupons', coalesce((select jsonb_agg(t order by t.id) from public.coupons t), '[]'::jsonb),
      'coupon_members', coalesce((select jsonb_agg(t order by t.coupon_id, t.member_id) from public.coupon_members t), '[]'::jsonb),
      'coupon_products', coalesce((select jsonb_agg(t order by t.coupon_id, t.product_id) from public.coupon_products t), '[]'::jsonb),
      'orders', coalesce((select jsonb_agg(t order by t.id) from public.orders t), '[]'::jsonb),
      'order_items', coalesce((select jsonb_agg(t order by t.id) from public.order_items t), '[]'::jsonb),
      'order_status_history', coalesce((select jsonb_agg(t order by t.id) from public.order_status_history t), '[]'::jsonb),
      'inventory_reservations', coalesce((select jsonb_agg(t order by t.id) from public.inventory_reservations t), '[]'::jsonb),
      'inventory_movements', coalesce((select jsonb_agg(t order by t.id) from public.inventory_movements t), '[]'::jsonb),
      'point_ledger', coalesce((select jsonb_agg(t order by t.id) from public.point_ledger t), '[]'::jsonb),
      'coupon_redemptions', coalesce((select jsonb_agg(t order by t.id) from public.coupon_redemptions t), '[]'::jsonb),
      'birthday_coupon_issues', coalesce((select jsonb_agg(t order by t.member_id, t.birthday_year) from public.birthday_coupon_issues t), '[]'::jsonb),
      'audit_logs', coalesce((select jsonb_agg(t order by t.id) from public.audit_logs t), '[]'::jsonb)
    )
  )
$function$;

revoke all on function public.backup_snapshot() from public, anon, authenticated;
grant execute on function public.backup_snapshot() to service_role;

commit;
