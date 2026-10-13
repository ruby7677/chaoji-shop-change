-- 潮吉好頑：備份快照補上 Auth 身分與 schema 版本（Worker src/database-backup.ts 每日呼叫）。
-- 202610100001 的快照不含 auth.users：還原到新專案後，會員以 LINE 登入會得到新的 user id，
-- 與 profiles／orders／point_ledger 的 member_id 對不上。這裡只帶重建「同一個 LINE 帳號對到同一個 user id」所需的欄位：
-- user id、建立時間，以及每個 identity 的 provider／provider_id／sub。
-- 刻意不含：密碼雜湊、email、電話、token、session、refresh token、MFA 因子與其餘 metadata。
-- migration_version 記錄產生快照時已套用的最新 migration，還原前必須先把目標資料庫套用到同一版本。
-- 讀取 auth schema 需要擁有者權限，因此改為 security definer；執行權限仍只給 service_role。

begin;

create or replace function public.backup_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select jsonb_build_object(
    'taken_at', now(),
    'format', 2,
    'migration_version', (select max(m.version) from supabase_migrations.schema_migrations m),
    'auth_users', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', u.id,
        'created_at', u.created_at,
        'identities', coalesce((
          select jsonb_agg(jsonb_build_object(
            'provider', i.provider,
            'provider_id', i.provider_id,
            'sub', i.identity_data ->> 'sub',
            'created_at', i.created_at
          ) order by i.provider, i.provider_id)
          from auth.identities i
          where i.user_id = u.id
        ), '[]'::jsonb)
      ) order by u.id)
      from auth.users u
    ), '[]'::jsonb),
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

comment on function public.backup_snapshot() is
  '每日備份快照（format 2）：營運資料表＋Auth 身分最小欄位（不含密碼、email、token、session）。security definer，僅 service_role 可執行。';

commit;
