-- 潮吉好頑：已執行 202609080001_initial_schema.sql 後的安全增量。
-- 可重複執行；請勿再次執行 initial schema。

begin;

-- Fail early with a clear message if the required initial migration is absent.
do $$
begin
  if to_regclass('public.profiles') is null then
    raise exception 'Required table public.profiles is missing. Apply the initial schema first.';
  end if;
  if to_regprocedure('public.create_pending_order(jsonb,text,integer,integer,uuid,text)') is null then
    raise exception 'Required function public.create_pending_order is missing. Apply the initial schema first.';
  end if;
end;
$$;

-- Avoid a recursive profiles RLS lookup and preserve the stored admin flag.
create or replace function public.current_user_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;

-- Every future Supabase Auth user receives a matching application profile.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id)
  values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists create_profile_after_signup on auth.users;
create trigger create_profile_after_signup
after insert on auth.users
for each row execute function public.handle_new_auth_user();

-- Backfill profiles for accounts that were created before the trigger existed.
insert into public.profiles (id)
select u.id
from auth.users u
on conflict (id) do nothing;

alter table public.profiles enable row level security;

-- Recreate the policy idempotently so members cannot promote themselves.
drop policy if exists "members update own profile" on public.profiles;
create policy "members update own profile"
on public.profiles
for update
using (auth.uid() = id)
with check (auth.uid() = id and is_admin = public.current_user_is_admin());

-- Members may update only customer-facing profile fields.
revoke update on public.profiles from authenticated;
grant update (full_name, phone, birthday, address) on public.profiles to authenticated;

-- Harden all security-definer functions introduced by the initial schema.
revoke all on function public.current_user_is_admin() from public;
grant execute on function public.current_user_is_admin() to authenticated;
revoke all on function public.handle_new_auth_user() from public;

revoke all on function public.create_pending_order(jsonb, text, integer, integer, uuid, text) from public, anon;
grant execute on function public.create_pending_order(jsonb, text, integer, integer, uuid, text) to authenticated;

commit;
