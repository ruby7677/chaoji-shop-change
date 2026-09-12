-- 潮吉好頑：補強管理員付款確認、逾期取消與訂單狀態歷程。
-- 前置需求：202609100003_admin_order_management.sql。
-- 可重複執行。

begin;

-- 保留既有 RPC 的付款確認邏輯，同步維護 initial schema 的 confirmed_at 欄位。
create or replace function public.sync_order_confirmation_timestamp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'confirmed' and old.status is distinct from new.status then
    new.confirmed_at := coalesce(new.confirmed_at, new.payment_confirmed_at, now());
  end if;
  return new;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'sync_order_confirmation_timestamp' and not tgisinternal) then
    create trigger sync_order_confirmation_timestamp
    before update of status on public.orders
    for each row execute function public.sync_order_confirmation_timestamp();
  end if;
end;
$$;

-- Migration 前已進入確認後狀態的訂單補齊 confirmed_at，避免報表出現空值。
update public.orders
set confirmed_at = coalesce(confirmed_at, payment_confirmed_at, updated_at)
where status in ('confirmed', 'partially_ready', 'ready_for_pickup', 'completed')
  and confirmed_at is null;

-- 逾期自動取消也必須留下稽核歷程，與管理員手動取消一致。
create or replace function public.cancel_expired_orders()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order record;
  v_count integer := 0;
begin
  for v_order in
    select id
    from public.orders
    where status = 'pending_payment'
      and payment_deadline <= now()
    for update skip locked
  loop
    update public.orders
    set status = 'cancelled', cancelled_at = now(), updated_at = now()
    where id = v_order.id;

    update public.inventory_reservations
    set released_at = coalesce(released_at, now())
    where order_id = v_order.id and released_at is null;

    insert into public.order_status_history(order_id, from_status, to_status, note, actor_id)
    values (v_order.id, 'pending_payment', 'cancelled', '付款期限逾期，系統自動取消', null);

    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.sync_order_confirmation_timestamp() from public, anon, authenticated;
revoke all on function public.cancel_expired_orders() from public, anon, authenticated;
grant execute on function public.cancel_expired_orders() to service_role;

commit;
