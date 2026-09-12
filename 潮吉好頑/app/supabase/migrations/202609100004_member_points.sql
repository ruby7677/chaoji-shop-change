-- 潮吉好頑：會員點數規則、帳務、管理員調整與訂單自動入點／沖回。
-- 前置需求：202609100003_admin_order_management.sql。
-- 可重複執行。

begin;

create table if not exists public.point_settings (
  id boolean primary key default true check (id),
  earn_amount_per_point integer not null default 100 check (earn_amount_per_point > 0),
  point_value integer not null default 1 check (point_value > 0),
  min_redeem_points integer not null default 1 check (min_redeem_points > 0),
  max_redeem_mode text not null default 'percent' check (max_redeem_mode in ('percent', 'fixed')),
  max_redeem_value integer not null default 100 check (max_redeem_value >= 0),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint point_settings_percent_limit check (max_redeem_mode <> 'percent' or max_redeem_value <= 100)
);

insert into public.point_settings(id) values (true) on conflict (id) do nothing;
alter table public.point_settings enable row level security;

create unique index if not exists point_ledger_one_earn_per_order
  on public.point_ledger(order_id) where kind = 'earn' and order_id is not null;
create unique index if not exists point_ledger_one_reversal_per_order
  on public.point_ledger(order_id) where kind = 'reversal' and order_id is not null;
create index if not exists point_ledger_member_created_idx
  on public.point_ledger(member_id, created_at desc);

create or replace view public.admin_member_summary as
select
  p.id,
  p.full_name,
  p.phone,
  p.birthday,
  p.address,
  p.is_admin,
  p.created_at,
  coalesce((select sum(pl.points) from public.point_ledger pl where pl.member_id = p.id), 0)::integer as point_balance,
  coalesce((select sum(o.amount_due) from public.orders o where o.member_id = p.id and o.status = 'completed'), 0)::integer as lifetime_spend,
  (select count(*) from public.orders o where o.member_id = p.id)::integer as order_count
from public.profiles p;

revoke all on public.admin_member_summary from public, anon, authenticated;
grant select on public.admin_member_summary to service_role;

create or replace function public.admin_update_point_settings(
  p_actor_id uuid,
  p_earn_amount_per_point integer,
  p_point_value integer,
  p_min_redeem_points integer,
  p_max_redeem_mode text,
  p_max_redeem_value integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if p_earn_amount_per_point <= 0 or p_point_value <= 0 or p_min_redeem_points <= 0 or p_max_redeem_value < 0 then raise exception 'INVALID_POINT_SETTINGS'; end if;
  if p_max_redeem_mode not in ('percent', 'fixed') or (p_max_redeem_mode = 'percent' and p_max_redeem_value > 100) then raise exception 'INVALID_POINT_SETTINGS'; end if;

  insert into public.point_settings(id, earn_amount_per_point, point_value, min_redeem_points, max_redeem_mode, max_redeem_value, updated_by, updated_at)
  values (true, p_earn_amount_per_point, p_point_value, p_min_redeem_points, p_max_redeem_mode, p_max_redeem_value, p_actor_id, now())
  on conflict (id) do update set
    earn_amount_per_point = excluded.earn_amount_per_point,
    point_value = excluded.point_value,
    min_redeem_points = excluded.min_redeem_points,
    max_redeem_mode = excluded.max_redeem_mode,
    max_redeem_value = excluded.max_redeem_value,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  return (select to_jsonb(s) from public.point_settings s where s.id = true);
end;
$$;

create or replace function public.admin_adjust_member_points(
  p_actor_id uuid,
  p_member_id uuid,
  p_points integer,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance integer;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if not exists (select 1 from public.profiles where id = p_member_id) then raise exception 'MEMBER_NOT_FOUND'; end if;
  if p_points = 0 then raise exception 'ZERO_POINT_ADJUSTMENT'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'REASON_REQUIRED'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_member_id::text, 0));
  select coalesce(sum(points), 0)::integer into v_balance from public.point_ledger where member_id = p_member_id;
  if v_balance + p_points < 0 then raise exception 'INSUFFICIENT_POINTS'; end if;

  insert into public.point_ledger(member_id, kind, points, reason, actor_id)
  values (p_member_id, 'manual', p_points, trim(p_reason), p_actor_id);
  return v_balance + p_points;
end;
$$;

create or replace function public.apply_points_from_order_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_earn_amount integer;
  v_points integer;
  v_balance_from_order integer;
begin
  select * into v_order from public.orders where id = new.order_id;
  if not found then return new; end if;

  if new.to_status = 'completed' and new.from_status <> 'completed' then
    select earn_amount_per_point into v_earn_amount from public.point_settings where id;
    v_points := floor(v_order.amount_due::numeric / v_earn_amount)::integer;
    if v_points > 0 then
      insert into public.point_ledger(member_id, order_id, kind, points, reason, actor_id)
      values (v_order.member_id, v_order.id, 'earn', v_points, '完成訂單 ' || v_order.order_number || ' 自動入點', new.actor_id)
      on conflict (order_id) where kind = 'earn' and order_id is not null do nothing;
    end if;
  elsif new.to_status = 'refunded' then
    select coalesce(sum(points), 0)::integer into v_balance_from_order
      from public.point_ledger
     where order_id = v_order.id and kind in ('earn', 'reversal');
    if v_balance_from_order > 0 then
      insert into public.point_ledger(member_id, order_id, kind, points, reason, actor_id)
      values (v_order.member_id, v_order.id, 'reversal', -v_balance_from_order, '退款訂單 ' || v_order.order_number || ' 扣回點數', new.actor_id)
      on conflict (order_id) where kind = 'reversal' and order_id is not null do nothing;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists apply_points_after_order_transition on public.order_status_history;
create trigger apply_points_after_order_transition
after insert on public.order_status_history
for each row execute function public.apply_points_from_order_history();

-- 優惠券與點數折抵尚未啟用前，拒絕客戶端自行送入折扣金額。
create or replace function public.reject_unverified_order_discounts()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.coupon_discount <> 0 or new.point_discount <> 0 then raise exception 'DISCOUNTS_NOT_ENABLED'; end if;
  return new;
end;
$$;

drop trigger if exists reject_unverified_order_discounts on public.orders;
create trigger reject_unverified_order_discounts
before insert or update of coupon_discount, point_discount on public.orders
for each row execute function public.reject_unverified_order_discounts();

-- 為 migration 前已完成但尚無入點紀錄的訂單補登。
insert into public.point_ledger(member_id, order_id, kind, points, reason)
select o.member_id, o.id, 'earn', floor(o.amount_due::numeric / s.earn_amount_per_point)::integer,
       '既有完成訂單 ' || o.order_number || ' 自動補登入點'
  from public.orders o cross join public.point_settings s
 where o.status = 'completed'
   and floor(o.amount_due::numeric / s.earn_amount_per_point)::integer > 0
on conflict (order_id) where kind = 'earn' and order_id is not null do nothing;

revoke all on function public.admin_update_point_settings(uuid, integer, integer, integer, text, integer) from public, anon, authenticated;
grant execute on function public.admin_update_point_settings(uuid, integer, integer, integer, text, integer) to service_role;
revoke all on function public.admin_adjust_member_points(uuid, uuid, integer, text) from public, anon, authenticated;
grant execute on function public.admin_adjust_member_points(uuid, uuid, integer, text) to service_role;
revoke all on function public.apply_points_from_order_history() from public, anon, authenticated;

commit;
