-- 潮吉好頑：LINE Official Account 通知紀錄與低庫存去重狀態。
-- 前置需求：202609100006_discounts.sql。
-- 通知憑證僅放在 Cloudflare secrets，不儲存在資料庫。
-- 可重複執行。

begin;

create table if not exists public.line_notification_logs (
  id uuid primary key default gen_random_uuid(),
  event_key text not null,
  recipient_id text not null,
  event_type text not null,
  status text not null default 'pending' check (status in ('pending','sent','failed')),
  error_message text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (event_key, recipient_id)
);

create table if not exists public.line_low_stock_states (
  variant_id uuid primary key references public.product_variants(id) on delete cascade,
  last_notified_stock integer,
  last_notified_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.line_notification_logs enable row level security;
alter table public.line_low_stock_states enable row level security;

revoke all on public.line_notification_logs from public, anon, authenticated;
revoke all on public.line_low_stock_states from public, anon, authenticated;
grant all on public.line_notification_logs to service_role;
grant all on public.line_low_stock_states to service_role;
grant execute on function public.issue_birthday_coupons() to service_role;

-- Custom LINE provider may expose the LINE subject in any of these common fields.
create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_line_id text;
begin
  v_line_id := coalesce(
    new.raw_user_meta_data->>'line_user_id',
    new.raw_user_meta_data->>'lineUserId',
    new.raw_user_meta_data->>'user_id',
    new.raw_user_meta_data->>'sub'
  );
  insert into public.profiles (id, line_user_id)
  values (new.id, nullif(trim(v_line_id), ''))
  on conflict (id) do update set line_user_id = coalesce(public.profiles.line_user_id, excluded.line_user_id);
  return new;
end;
$$;

update public.profiles p
set line_user_id = coalesce(
  p.line_user_id,
  nullif(trim(u.raw_user_meta_data->>'line_user_id'), ''),
  nullif(trim(u.raw_user_meta_data->>'lineUserId'), ''),
  nullif(trim(u.raw_user_meta_data->>'user_id'), ''),
  nullif(trim(u.raw_user_meta_data->>'sub'), '')
)
from auth.users u
where u.id = p.id and p.line_user_id is null;

commit;
