-- 潮吉好頑：訂單安全邊界、好友驗證、庫存保留與資料庫最小權限。
-- 前置需求：目前 migrations 目錄內的所有既有 migration。
-- 本 migration 只新增欄位／觸發器、收緊 grants，不刪除既有訂單資料。

begin;

alter table public.profiles
  add column if not exists line_friend_verified_at timestamptz;

comment on column public.profiles.line_friend_verified_at is
  '最近一次由 LINE Login token 驗證官方帳號好友狀態的時間；會員不可自行修改';

create index if not exists profiles_line_friend_verified_idx
  on public.profiles(line_friend_verified_at);

-- 所有未來下單入口（Worker 與 Supabase RPC）都必須經過伺服器驗證的
-- LINE 好友時間戳；不能只依賴前端 dialog。
create or replace function public.enforce_line_friendship_on_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.member_id is null
     or not exists (
       select 1
       from public.profiles p
       where p.id = new.member_id
         and p.line_friend_verified_at is not null
         and p.line_friend_verified_at > current_timestamp - interval '15 minutes'
     ) then
    raise exception 'LINE_FRIEND_REQUIRED';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_require_line_friendship on public.orders;
create trigger orders_require_line_friendship
before insert on public.orders
for each row execute function public.enforce_line_friendship_on_order();

-- 防止重複點擊／直接 RPC 在短時間內大量占用訂單與庫存。
create or replace function public.enforce_order_creation_limits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recent_count integer;
  v_pending_count integer;
begin
  if new.status not in ('pending_payment', 'pending_review') then
    return new;
  end if;

  perform 1
  from public.profiles p
  where p.id = new.member_id
  for update;
  if not found then
    raise exception 'LOGIN_REQUIRED';
  end if;

  select count(*)::integer
    into v_recent_count
  from public.orders o
  where o.member_id = new.member_id
    and o.created_at > current_timestamp - interval '10 minutes';
  if v_recent_count >= 10 then
    raise exception 'ORDER_RATE_LIMITED';
  end if;

  select count(*)::integer
    into v_pending_count
  from public.orders o
  where o.member_id = new.member_id
    and o.status in ('pending_payment', 'pending_review');
  if v_pending_count >= 5 then
    raise exception 'PENDING_ORDER_LIMIT';
  end if;

  return new;
end;
$$;

drop trigger if exists orders_limit_creation on public.orders;
create trigger orders_limit_creation
before insert on public.orders
for each row execute function public.enforce_order_creation_limits();

create index if not exists orders_member_status_created_idx
  on public.orders(member_id, status, created_at desc);

-- 同一訂單不可重複插入同一規格；避免 JSON 陣列重複造成超額 reservation。
create unique index if not exists order_items_one_variant_per_order
  on public.order_items(order_id, variant_id);

-- 將 products.purchase_limit 從前端限制提升為資料庫強制規則，並以會員鎖
-- 保護兩個並行下單請求。
create or replace function public.enforce_member_purchase_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member_id uuid;
  v_product_id uuid;
  v_limit integer;
  v_existing integer;
begin
  select o.member_id
    into v_member_id
  from public.orders o
  where o.id = new.order_id;
  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  select p.id, p.purchase_limit
    into v_product_id, v_limit
  from public.product_variants v
  join public.products p on p.id = v.product_id
  where v.id = new.variant_id;
  if not found then
    raise exception 'PRODUCT_NOT_FOUND';
  end if;
  if v_limit is null then
    return new;
  end if;

  perform 1
  from public.profiles p
  where p.id = v_member_id
  for update;

  select coalesce(sum(oi.quantity), 0)::integer
    into v_existing
  from public.order_items oi
  join public.orders o on o.id = oi.order_id
  join public.product_variants v2 on v2.id = oi.variant_id
  where o.member_id = v_member_id
    and v2.product_id = v_product_id
    and o.status not in ('cancelled', 'refunded');

  if v_existing + new.quantity > v_limit then
    raise exception 'PURCHASE_LIMIT_EXCEEDED';
  end if;
  return new;
end;
$$;

drop trigger if exists order_items_enforce_purchase_limit on public.order_items;
create trigger order_items_enforce_purchase_limit
before insert on public.order_items
for each row execute function public.enforce_member_purchase_limit();

-- 付款回報後仍保留庫存，但只保留到原付款期限；不再使用 infinity。
create or replace function public.sync_order_reservation_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deadline timestamptz;
begin
  if tg_op = 'INSERT' then
    select o.payment_deadline
      into v_deadline
    from public.orders o
    where o.id = new.order_id
      and o.status in ('pending_payment', 'pending_review');
    if v_deadline is not null then
      new.expires_at := v_deadline;
    end if;
    return new;
  end if;

  if new.status = 'pending_review' and old.status is distinct from new.status then
    update public.inventory_reservations
       set expires_at = least(expires_at, new.payment_deadline)
     where order_id = new.id and released_at is null;
  elsif new.status in ('confirmed', 'cancelled') and old.status is distinct from new.status then
    update public.inventory_reservations
       set released_at = coalesce(released_at, current_timestamp)
     where order_id = new.id and released_at is null;
  end if;
  return new;
end;
$$;

-- 已存在的 pending_review 保留也改回付款期限；目前無資料時不會產生變更。
update public.inventory_reservations r
   set expires_at = o.payment_deadline
  from public.orders o
 where o.id = r.order_id
   and o.status = 'pending_review'
   and r.released_at is null
   and r.expires_at = 'infinity'::timestamptz;

-- 逾期清理同時涵蓋 pending_payment 與 pending_review，並使用 row lock
-- 避免與管理員確認付款同時執行。
create or replace function public.cancel_expired_orders()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order record;
  v_count integer := 0;
begin
  for v_order in
    select o.id, o.status
    from public.orders o
    where o.status in ('pending_payment', 'pending_review')
      and o.payment_deadline <= current_timestamp
    for update skip locked
  loop
    update public.orders
       set status = 'cancelled',
           cancelled_at = current_timestamp,
           updated_at = current_timestamp
     where id = v_order.id;

    update public.inventory_reservations
       set released_at = coalesce(released_at, current_timestamp)
     where order_id = v_order.id and released_at is null;

    insert into public.order_status_history(order_id, from_status, to_status, note, actor_id)
    values (v_order.id, v_order.status, 'cancelled', '付款期限逾期，系統自動取消', null);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- 目前 Worker 不再使用的舊下單 RPC 撤銷 authenticated 執行權，避免繞過
-- 新版 Worker 的好友驗證、body 上限與訂單限制。
revoke all on function public.create_pending_order(jsonb, text, integer, integer, uuid, text) from public, anon, authenticated;
revoke all on function public.create_discounted_order(jsonb, text, text, integer, uuid, text) from public, anon, authenticated;
revoke all on function public.calculate_shipping_fee(text, integer) from public, anon, authenticated;

-- Data API 只保留實際需要的最小 table grants；RLS 仍是第二層防線。
revoke all on table public.profiles from anon, authenticated;
grant select on table public.profiles to authenticated;
grant update (full_name, phone, birthday, address) on table public.profiles to authenticated;

revoke all on table public.categories, public.products, public.product_variants from anon, authenticated;
grant select on table public.categories, public.products, public.product_variants to anon, authenticated;

revoke all on table public.storefront_variants from anon, authenticated;
grant select on table public.storefront_variants to anon, authenticated;

revoke all on table public.orders, public.order_items from anon, authenticated;
grant select on table public.orders, public.order_items to authenticated;

revoke all on table
  public.inventory_reservations,
  public.inventory_movements,
  public.bank_accounts,
  public.point_ledger,
  public.point_settings,
  public.order_status_history,
  public.coupons,
  public.coupon_products,
  public.coupon_members,
  public.coupon_redemptions,
  public.birthday_coupon_settings,
  public.birthday_coupon_issues,
  public.shipping_settings_legacy
from anon, authenticated;

-- 未來新增在 public schema 的物件預設不對前端角色開放，需在 migration
-- 中明確 grant；避免再次產生「RLS 開啟但 table grant 過寬」。
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- 所有 SECURITY DEFINER 函式改用空 search_path；現有函式內的資料表與
-- 函式呼叫均使用 public／auth schema-qualified 名稱。
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
  loop
    execute format('alter function %s set search_path = %L', f.signature, '');
  end loop;
end;
$$;

revoke all on function public.enforce_line_friendship_on_order() from public, anon, authenticated;
revoke all on function public.enforce_order_creation_limits() from public, anon, authenticated;
revoke all on function public.enforce_member_purchase_limit() from public, anon, authenticated;
grant execute on function public.cancel_expired_orders() to service_role;

commit;
