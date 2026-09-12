-- 潮吉好頑：管理員訂單狀態、付款確認、庫存扣除與稽核紀錄。
-- 前置需求：202609100001_order_payment_flow.sql 與 202609100002_admin_catalog_management.sql。
-- 可重複執行。

begin;

alter table public.orders
  add column if not exists paid_amount integer not null default 0 check (paid_amount >= 0),
  add column if not exists payment_confirmed_at timestamptz;

create table if not exists public.order_status_history (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  from_status public.order_status not null,
  to_status public.order_status not null,
  note text not null default '',
  actor_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists order_status_history_order_created_idx
  on public.order_status_history(order_id, created_at desc);

alter table public.order_status_history enable row level security;

-- 回報付款後持續保留庫存；確認或取消時由訂單流程釋放。
create or replace function public.sync_order_reservation_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if exists (select 1 from public.orders where id = new.order_id and status = 'pending_review') then
      new.expires_at := 'infinity'::timestamptz;
    end if;
    return new;
  end if;

  if new.status = 'pending_review' and old.status is distinct from new.status then
    update public.inventory_reservations
       set expires_at = 'infinity'::timestamptz
     where order_id = new.id and released_at is null;
  elsif new.status in ('confirmed', 'cancelled') and old.status is distinct from new.status then
    update public.inventory_reservations
       set released_at = coalesce(released_at, now())
     where order_id = new.id and released_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists hold_reported_payment_reservations on public.inventory_reservations;
create trigger hold_reported_payment_reservations
before insert on public.inventory_reservations
for each row execute function public.sync_order_reservation_lifecycle();

drop trigger if exists sync_reservations_after_order_status on public.orders;
create trigger sync_reservations_after_order_status
after update of status on public.orders
for each row execute function public.sync_order_reservation_lifecycle();

update public.inventory_reservations r
   set expires_at = 'infinity'::timestamptz
  from public.orders o
 where o.id = r.order_id
   and o.status = 'pending_review'
   and r.released_at is null;

create or replace function public.admin_transition_order(
  p_actor_id uuid,
  p_order_id uuid,
  p_target_status public.order_status,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders%rowtype;
  v_item record;
  v_stock integer;
  v_note text := coalesce(trim(p_note), '');
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then
    raise exception 'ADMIN_REQUIRED';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.status = p_target_status then raise exception 'ORDER_STATUS_UNCHANGED'; end if;

  if not (
    (v_order.status = 'pending_payment' and p_target_status = 'cancelled') or
    (v_order.status = 'pending_review' and p_target_status in ('confirmed', 'cancelled')) or
    (v_order.status = 'confirmed' and p_target_status in ('partially_ready', 'ready_for_pickup', 'completed', 'cancelled', 'refund_pending')) or
    (v_order.status = 'partially_ready' and p_target_status in ('ready_for_pickup', 'completed', 'cancelled', 'refund_pending')) or
    (v_order.status = 'ready_for_pickup' and p_target_status in ('completed', 'cancelled', 'refund_pending')) or
    (v_order.status = 'completed' and p_target_status = 'refund_pending') or
    (v_order.status = 'refund_pending' and p_target_status in ('refunded', 'completed'))
  ) then
    raise exception 'INVALID_ORDER_TRANSITION';
  end if;

  if p_target_status in ('cancelled', 'refund_pending', 'refunded') and v_note = '' then
    raise exception 'ORDER_NOTE_REQUIRED';
  end if;
  if p_target_status = 'partially_ready' and v_order.pickup_plan <> 'split' then
    raise exception 'PARTIAL_READY_REQUIRES_SPLIT';
  end if;

  -- 只有首次確認訂金／款項時扣除實際庫存，交易失敗會整筆回滾。
  if v_order.status = 'pending_review' and p_target_status = 'confirmed' then
    if v_order.payment_last_five is null then raise exception 'PAYMENT_REPORT_REQUIRED'; end if;
    for v_item in
      select oi.variant_id, oi.quantity
        from public.order_items oi
       where oi.order_id = p_order_id
       order by oi.variant_id
    loop
      select stock_on_hand into v_stock
        from public.product_variants
       where id = v_item.variant_id
       for update;
      if not found or v_stock < v_item.quantity then raise exception 'INSUFFICIENT_STOCK'; end if;
      update public.product_variants
         set stock_on_hand = stock_on_hand - v_item.quantity, updated_at = now()
       where id = v_item.variant_id;
      insert into public.inventory_movements(variant_id, order_id, kind, quantity_delta, reason, actor_id)
      values (v_item.variant_id, p_order_id, 'sale', -v_item.quantity, '確認訂單 ' || v_order.order_number || ' 付款', p_actor_id);
    end loop;
  end if;

  update public.orders
     set status = p_target_status,
         admin_note = case when v_note = '' then admin_note else v_note end,
         paid_amount = case
           when p_target_status = 'confirmed' then deposit_due
           when p_target_status = 'completed' then amount_due
           else paid_amount
         end,
         payment_confirmed_at = case when p_target_status = 'confirmed' then now() else payment_confirmed_at end,
         completed_at = case when p_target_status = 'completed' then now() else completed_at end,
         cancelled_at = case when p_target_status = 'cancelled' then now() else cancelled_at end,
         updated_at = now()
   where id = p_order_id;

  insert into public.order_status_history(order_id, from_status, to_status, note, actor_id)
  values (p_order_id, v_order.status, p_target_status, v_note, p_actor_id);

  return jsonb_build_object('id', p_order_id, 'status', p_target_status, 'paid_amount',
    case when p_target_status = 'confirmed' then v_order.deposit_due when p_target_status = 'completed' then v_order.amount_due else v_order.paid_amount end);
end;
$$;

revoke all on function public.sync_order_reservation_lifecycle() from public, anon, authenticated;
revoke all on function public.admin_transition_order(uuid, uuid, public.order_status, text) from public, anon, authenticated;
grant execute on function public.admin_transition_order(uuid, uuid, public.order_status, text) to service_role;

commit;
