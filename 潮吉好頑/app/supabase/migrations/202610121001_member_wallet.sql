-- 潮吉好頑：會員儲值金（線上一番賞 Stage 2，規劃見 LOTTERY_PLAN.md §3.1）。
-- 1. 儲值金與回饋點數完全分開：1 元＝1 元、永不到期；餘額存在 wallet_accounts，
--    每筆異動同一交易寫入不可修改的 wallet_ledger，check (balance >= 0) 讓資料庫保證餘額不為負。
-- 2. 管理員加值／退款／調整：admin_adjust_wallet；錯帳以 admin_reverse_wallet_entry 沖正，不改歷史紀錄。
--    兩者都必須帶 request_id，同一請求重送只回傳原結果，不重複入帳；同時寫 audit_logs。
-- 3. 會員以自己的 JWT 讀取餘額（member_wallet_balance）與自己的紀錄（RLS），寫入一律只經由上述函式。
-- 4. 每週備份 backup_snapshot() 納入 wallet_accounts、wallet_ledger。
-- 版本號使用 1001 起，避免與 master 同日的修正 migration（0001 起）撞號。

begin;

create table if not exists public.wallet_accounts (
  member_id uuid primary key references public.profiles(id) on delete restrict,
  balance integer not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.profiles(id) on delete restrict,
  kind text not null check (kind in ('topup', 'adjust', 'refund', 'reversal', 'draw', 'shipping')),
  amount integer not null check (amount <> 0),
  balance_after integer not null check (balance_after >= 0),
  reversal_of uuid references public.wallet_ledger(id) on delete restrict,
  request_id uuid unique,
  transfer_ref text check (transfer_ref is null or char_length(transfer_ref) between 1 and 60),
  reason text not null check (char_length(reason) between 1 and 200),
  -- restrict 而非 set null：set null 是 UPDATE，會被不可修改觸發器擋下；與 audit_logs.actor_id 相同。
  actor_id uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint wallet_ledger_reversal_link check ((kind = 'reversal') = (reversal_of is not null)),
  constraint wallet_ledger_topup_positive check (kind <> 'topup' or amount > 0),
  constraint wallet_ledger_refund_negative check (kind <> 'refund' or amount < 0)
);

create unique index if not exists wallet_ledger_one_reversal_per_entry on public.wallet_ledger(reversal_of) where reversal_of is not null;
create index if not exists wallet_ledger_member_created_idx on public.wallet_ledger(member_id, created_at desc);

comment on table public.wallet_accounts is '會員儲值金目前餘額；只能經由 security definer 函式在同一交易內與 wallet_ledger 一起更新';
comment on table public.wallet_ledger is '會員儲值金異動紀錄，不可修改或刪除；錯帳以 kind = reversal 沖正';

-- 不可修改：API 角色（含 service_role）沒有寫入權限，觸發器再擋住擁有者以外的任何 UPDATE／DELETE。
create or replace function public.prevent_wallet_ledger_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'WALLET_LEDGER_IMMUTABLE';
end;
$$;

drop trigger if exists wallet_ledger_immutable on public.wallet_ledger;
create trigger wallet_ledger_immutable
before update or delete on public.wallet_ledger
for each row execute function public.prevent_wallet_ledger_mutation();

revoke all on function public.prevent_wallet_ledger_mutation() from public, anon, authenticated, service_role;

alter table public.wallet_accounts enable row level security;
alter table public.wallet_ledger enable row level security;

drop policy if exists "members view own wallet account" on public.wallet_accounts;
create policy "members view own wallet account" on public.wallet_accounts
  for select to authenticated
  using (member_id = (select auth.uid()));

drop policy if exists "members view own wallet ledger" on public.wallet_ledger;
create policy "members view own wallet ledger" on public.wallet_ledger
  for select to authenticated
  using (member_id = (select auth.uid()));

revoke all on table public.wallet_accounts from public, anon, authenticated, service_role;
revoke all on table public.wallet_ledger from public, anon, authenticated, service_role;
grant select (member_id, balance, updated_at) on table public.wallet_accounts to authenticated;
-- 會員看不到操作的管理員、request_id 與匯款參照。
grant select (id, member_id, kind, amount, balance_after, reason, created_at) on table public.wallet_ledger to authenticated;
-- 後台以 service_role 讀取帳戶與完整紀錄；寫入仍只能經由函式。
grant select on table public.wallet_accounts to service_role;
grant select on table public.wallet_ledger to service_role;

alter table public.audit_logs drop constraint if exists audit_logs_resource_check;
alter table public.audit_logs add constraint audit_logs_resource_check
  check (resource in ('product', 'product_variant', 'category', 'bank_account', 'coupon', 'birthday_coupon_settings', 'point_settings', 'member_points', 'product_image', 'notification_delivery', 'member_wallet'));

-- 鎖定（必要時建立）會員錢包並回傳目前餘額；呼叫端須在同一交易內完成異動。
create or replace function private.lock_wallet_account(p_member_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance integer;
begin
  insert into public.wallet_accounts(member_id) values (p_member_id) on conflict (member_id) do nothing;
  select balance into v_balance from public.wallet_accounts where member_id = p_member_id for update;
  return v_balance;
end;
$$;

revoke all on function private.lock_wallet_account(uuid) from public, anon, authenticated, service_role;

create or replace function public.admin_adjust_wallet(
  p_actor_id uuid,
  p_member_id uuid,
  p_kind text,
  p_amount integer,
  p_reason text,
  p_request_id uuid,
  p_transfer_ref text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_transfer_ref text := nullif(trim(coalesce(p_transfer_ref, '')), '');
  v_existing public.wallet_ledger%rowtype;
  v_before integer;
  v_after integer;
  v_entry_id uuid;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if p_request_id is null then raise exception 'WALLET_REQUEST_ID_MISSING'; end if;
  if not exists (select 1 from public.profiles where id = p_member_id) then raise exception 'MEMBER_NOT_FOUND'; end if;
  if p_kind is null or p_kind not in ('topup', 'adjust', 'refund') then raise exception 'WALLET_KIND_INVALID'; end if;
  if p_amount is null or p_amount = 0 or abs(p_amount) > 1000000
     or (p_kind = 'topup' and p_amount < 0) or (p_kind = 'refund' and p_amount > 0) then
    raise exception 'WALLET_AMOUNT_INVALID';
  end if;
  if v_reason is null or char_length(v_reason) > 200 then raise exception 'WALLET_NOTE_MISSING'; end if;
  if v_transfer_ref is not null and char_length(v_transfer_ref) > 60 then raise exception 'WALLET_REF_INVALID'; end if;

  -- 同一 request_id 的重送依序處理：已成功的直接回傳原結果，參數不同則拒絕。
  perform pg_advisory_xact_lock(hashtextextended('wallet-request:' || p_request_id::text, 0));
  select * into v_existing from public.wallet_ledger where request_id = p_request_id;
  if found then
    if v_existing.member_id = p_member_id and v_existing.kind = p_kind and v_existing.amount = p_amount then
      return jsonb_build_object('entry_id', v_existing.id, 'balance', v_existing.balance_after, 'replayed', true);
    end if;
    raise exception 'WALLET_REQUEST_REUSED';
  end if;

  v_before := private.lock_wallet_account(p_member_id);
  v_after := v_before + p_amount;
  if v_after < 0 then raise exception 'WALLET_BALANCE_SHORT'; end if;

  update public.wallet_accounts set balance = v_after, updated_at = now() where member_id = p_member_id;
  insert into public.wallet_ledger(member_id, kind, amount, balance_after, request_id, transfer_ref, reason, actor_id)
  values (p_member_id, p_kind, p_amount, v_after, p_request_id, v_transfer_ref, v_reason, p_actor_id)
  returning id into v_entry_id;

  perform public.append_audit_log(p_actor_id, 'adjust', 'member_wallet', p_member_id::text,
    jsonb_build_object('balance', v_before),
    jsonb_build_object('balance', v_after, 'entry_id', v_entry_id, 'kind', p_kind, 'amount', p_amount, 'reason', v_reason, 'transfer_ref', v_transfer_ref));
  return jsonb_build_object('entry_id', v_entry_id, 'balance', v_after, 'replayed', false);
end;
$function$;

-- 沖正管理員造成的異動（加值／調整／退款）；抽獎與運費的沖正留待對應 Stage 定義。
create or replace function public.admin_reverse_wallet_entry(
  p_actor_id uuid,
  p_entry_id uuid,
  p_reason text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_existing public.wallet_ledger%rowtype;
  v_entry public.wallet_ledger%rowtype;
  v_before integer;
  v_after integer;
  v_entry_id uuid;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if p_request_id is null then raise exception 'WALLET_REQUEST_ID_MISSING'; end if;
  if v_reason is null or char_length(v_reason) > 200 then raise exception 'WALLET_NOTE_MISSING'; end if;

  perform pg_advisory_xact_lock(hashtextextended('wallet-request:' || p_request_id::text, 0));
  select * into v_existing from public.wallet_ledger where request_id = p_request_id;
  if found then
    if v_existing.kind = 'reversal' and v_existing.reversal_of = p_entry_id then
      return jsonb_build_object('entry_id', v_existing.id, 'balance', v_existing.balance_after, 'replayed', true);
    end if;
    raise exception 'WALLET_REQUEST_REUSED';
  end if;

  select * into v_entry from public.wallet_ledger where id = p_entry_id;
  if not found then raise exception 'WALLET_ENTRY_NOT_FOUND'; end if;
  if v_entry.kind not in ('topup', 'adjust', 'refund') then raise exception 'WALLET_REVERSAL_INVALID'; end if;

  v_before := private.lock_wallet_account(v_entry.member_id);
  -- 錢包鎖定後才檢查，兩個不同 request_id 同時沖正同一筆時，第二筆在這裡被擋下。
  if exists (select 1 from public.wallet_ledger where reversal_of = p_entry_id) then raise exception 'WALLET_ALREADY_REVERSED'; end if;
  v_after := v_before - v_entry.amount;
  if v_after < 0 then raise exception 'WALLET_BALANCE_SHORT'; end if;

  update public.wallet_accounts set balance = v_after, updated_at = now() where member_id = v_entry.member_id;
  insert into public.wallet_ledger(member_id, kind, amount, balance_after, reversal_of, request_id, reason, actor_id)
  values (v_entry.member_id, 'reversal', -v_entry.amount, v_after, p_entry_id, p_request_id, v_reason, p_actor_id)
  returning id into v_entry_id;

  perform public.append_audit_log(p_actor_id, 'adjust', 'member_wallet', v_entry.member_id::text,
    jsonb_build_object('balance', v_before),
    jsonb_build_object('balance', v_after, 'entry_id', v_entry_id, 'kind', 'reversal', 'amount', -v_entry.amount, 'reversal_of', p_entry_id, 'reason', v_reason));
  return jsonb_build_object('entry_id', v_entry_id, 'balance', v_after, 'replayed', false);
end;
$function$;

create or replace function public.member_wallet_balance()
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_member_id uuid := auth.uid();
begin
  if v_member_id is null then raise exception 'LOGIN_REQUIRED'; end if;
  return coalesce((select balance from public.wallet_accounts where member_id = v_member_id), 0);
end;
$function$;

revoke all on function public.admin_adjust_wallet(uuid, uuid, text, integer, text, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.admin_reverse_wallet_entry(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.member_wallet_balance() from public, anon, service_role;
grant execute on function public.admin_adjust_wallet(uuid, uuid, text, integer, text, uuid, text) to service_role;
grant execute on function public.admin_reverse_wallet_entry(uuid, uuid, text, uuid) to service_role;
grant execute on function public.member_wallet_balance() to authenticated;

-- 4. 每週備份納入儲值金帳戶與帳本（其餘內容與 202610100001 相同）。
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
      'wallet_accounts', coalesce((select jsonb_agg(t order by t.member_id) from public.wallet_accounts t), '[]'::jsonb),
      'wallet_ledger', coalesce((select jsonb_agg(t order by t.id) from public.wallet_ledger t), '[]'::jsonb),
      'audit_logs', coalesce((select jsonb_agg(t order by t.id) from public.audit_logs t), '[]'::jsonb)
    )
  )
$function$;

revoke all on function public.backup_snapshot() from public, anon, authenticated;
grant execute on function public.backup_snapshot() to service_role;

commit;
