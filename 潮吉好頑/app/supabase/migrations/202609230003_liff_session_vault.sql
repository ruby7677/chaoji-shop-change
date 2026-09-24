-- 潮吉好頑：LIFF 伺服器端登入保存。
-- 以 Worker 驗證過的 LIFF ID Token（LINE sub）為鍵，保存以 AUTH_SESSION_SECRET
-- 加密的 Supabase refresh token；LINE WebView Cookie 遺失時不必再跳轉 OAuth。
-- 明文 token 不落地，僅 Worker service_role 可讀寫。

begin;

create table if not exists public.liff_session_vault (
  line_user_id text primary key check (line_user_id ~ '^U[0-9a-fA-F]{32}$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  sealed_refresh_token text not null check (char_length(sealed_refresh_token) between 16 and 16384),
  updated_at timestamptz not null default now()
);

create index if not exists liff_session_vault_user_id_idx on public.liff_session_vault (user_id);

alter table public.liff_session_vault enable row level security;
revoke all on table public.liff_session_vault from public, anon, authenticated;
grant all on table public.liff_session_vault to service_role;

drop policy if exists "deny api roles" on public.liff_session_vault;
create policy "deny api roles"
  on public.liff_session_vault
  for all to anon, authenticated
  using (false)
  with check (false);

comment on table public.liff_session_vault is
  'LIFF 無感登入：LINE sub 對應的加密 Supabase refresh token，僅供 Worker service_role 使用';

commit;
