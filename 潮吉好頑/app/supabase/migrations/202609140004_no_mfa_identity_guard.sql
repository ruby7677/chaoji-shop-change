-- 潮吉好頑：採用 LINE Login + is_admin 的無 MFA 管理模式。
--
-- 會員資料 API 只允許更新聯絡欄位；LINE identity 與管理員標記由
-- Worker／service role 維護，避免前端直接改寫信任根。

begin;

create or replace function private.protect_profile_identity_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- auth.uid() is populated for authenticated/anonymous Data API calls and is
  -- null for the trusted service-role maintenance request.
  if auth.uid() is not null
     and (new.line_user_id is distinct from old.line_user_id
       or new.is_admin is distinct from old.is_admin) then
    raise exception 'PROFILE_IDENTITY_FIELDS_READ_ONLY'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.protect_profile_identity_fields() from public, anon, authenticated;

drop trigger if exists profiles_identity_fields_guard on public.profiles;
create trigger profiles_identity_fields_guard
before update of line_user_id, is_admin on public.profiles
for each row execute function private.protect_profile_identity_fields();

revoke update on table public.profiles from anon, authenticated;
grant update (full_name, phone, birthday, address) on table public.profiles to authenticated;

comment on function private.protect_profile_identity_fields() is
  'Prevents client roles from changing LINE identity or admin marker; service role maintains both.';

commit;
