-- 取消／退貨庫存正式流程：
-- 1. 未扣庫存取消只由既有 reservation lifecycle 釋放保留。
-- 2. 已扣庫存、尚未完成交付的取消，原子反轉原 sale movement，且每筆 sale 只可回補一次。
-- 3. refunded 不自動回補；退貨收到後由管理員以正式 return confirmation 決定可再售/報廢數量。

begin;

alter table public.inventory_movements
  add column if not exists source_movement_id uuid
    references public.inventory_movements(id);

create unique index if not exists inventory_movements_one_refund_per_sale_idx
  on public.inventory_movements(source_movement_id)
  where kind = 'refund' and source_movement_id is not null;

create table if not exists public.inventory_return_confirmations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id),
  order_item_id uuid not null references public.order_items(id),
  sale_movement_id uuid not null references public.inventory_movements(id),
  received_quantity integer not null check (received_quantity > 0),
  restock_quantity integer not null check (restock_quantity >= 0),
  scrap_quantity integer not null check (scrap_quantity >= 0),
  note text not null default '',
  actor_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  unique(order_item_id),
  unique(sale_movement_id),
  check (restock_quantity + scrap_quantity = received_quantity)
);

alter table public.inventory_movements
  add column if not exists return_confirmation_id uuid
    references public.inventory_return_confirmations(id);

create unique index if not exists inventory_movements_return_confirmation_idx
  on public.inventory_movements(return_confirmation_id)
  where return_confirmation_id is not null;

alter table public.inventory_return_confirmations enable row level security;
drop policy if exists "deny api roles" on public.inventory_return_confirmations;
create policy "deny api roles"
  on public.inventory_return_confirmations
  for all
  to anon, authenticated
  using (false)
  with check (false);
revoke all on table public.inventory_return_confirmations from public, anon, authenticated;
grant all on table public.inventory_return_confirmations to service_role;

create or replace function public.admin_transition_order(
  p_actor_id uuid,
  p_order_id uuid,
  p_target_status public.order_status,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_order public.orders%rowtype;
  v_item record;
  v_sale public.inventory_movements%rowtype;
  v_stock integer;
  v_note text := coalesce(trim(p_note), '');
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then
    raise exception 'ADMIN_REQUIRED';
  end if;
  select * into v_order
    from public.orders
   where id = p_order_id
   for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.status = p_target_status then raise exception 'ORDER_STATUS_UNCHANGED'; end if;

  -- ready_for_pickup is the shipped state for in-stock seller-delivery orders.
  -- The database cannot prove whether an external 7-11 parcel was handed over,
  -- so use the conservative refund/return flow instead of auto-restocking it.
  if p_target_status = 'cancelled'
     and v_order.delivery_method = 'seller_delivery'
     and v_order.status = 'ready_for_pickup' then
    raise exception 'SELLER_DELIVERY_SHIPPED_REQUIRES_REFUND';
  end if;

  if not (
    (v_order.status = 'pending_payment' and p_target_status = 'cancelled') or
    (v_order.status = 'pending_payment' and v_order.bank_account_id is null and p_target_status = 'confirmed') or
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
  if p_target_status = 'completed'
     and v_order.delivery_method = 'home_delivery'
     and v_order.final_payment_confirmed_at is null then
    raise exception 'FINAL_PAYMENT_REQUIRED';
  end if;

  if p_target_status = 'confirmed'
     and (v_order.status = 'pending_review' or (v_order.status = 'pending_payment' and v_order.bank_account_id is null)) then
    if v_order.status = 'pending_review' and v_order.payment_last_five is null then
      raise exception 'PAYMENT_REPORT_REQUIRED';
    end if;
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
         set stock_on_hand = stock_on_hand - v_item.quantity,
             updated_at = now()
       where id = v_item.variant_id;
      insert into public.inventory_movements(variant_id, order_id, kind, quantity_delta, reason, actor_id)
      values (
        v_item.variant_id,
        p_order_id,
        'sale',
        -v_item.quantity,
        case when v_order.bank_account_id is null
          then '確認到店支付訂單 ' || v_order.order_number
          else '確認訂單 ' || v_order.order_number || ' 付款'
        end,
        p_actor_id
      );
    end loop;
  end if;

  if p_target_status = 'cancelled' then
    -- pending_payment / pending_review 尚未產生 sale；此迴圈為空，只由 reservation trigger 釋放保留。
    -- confirmed 之後已有 sale 的訂單仍未 completed，取消時才逐筆反轉實體庫存。
    for v_sale in
      select im.*
        from public.inventory_movements im
       where im.order_id = p_order_id
         and im.kind = 'sale'
       order by im.variant_id, im.id
       for update
    loop
      if not exists (
        select 1
          from public.inventory_movements reversal
         where reversal.source_movement_id = v_sale.id
           and reversal.kind = 'refund'
      ) then
        update public.product_variants
           set stock_on_hand = stock_on_hand + abs(v_sale.quantity_delta),
               updated_at = now()
         where id = v_sale.variant_id;
        insert into public.inventory_movements(
          variant_id, order_id, kind, quantity_delta, reason, actor_id, source_movement_id
        )
        values (
          v_sale.variant_id,
          p_order_id,
          'refund',
          abs(v_sale.quantity_delta),
          '取消訂單 ' || v_order.order_number || ' 回補未交付庫存',
          p_actor_id,
          v_sale.id
        );
      end if;
    end loop;
  end if;

  update public.orders
     set status = p_target_status,
         admin_note = case when v_note = '' then admin_note else v_note end,
         paid_amount = case
           when p_target_status = 'confirmed' then case when v_order.final_payment_confirmed_at is not null then amount_due else deposit_due end
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

  return jsonb_build_object(
    'id', p_order_id,
    'status', p_target_status,
    'paid_amount', case
      when p_target_status = 'confirmed' then
        case when v_order.final_payment_confirmed_at is not null then v_order.amount_due else v_order.deposit_due end
      when p_target_status = 'completed' then v_order.amount_due
      else v_order.paid_amount
    end
  );
end;
$function$;

create or replace function public.admin_confirm_order_return(
  p_actor_id uuid,
  p_order_item_id uuid,
  p_received_quantity integer,
  p_restock_quantity integer,
  p_scrap_quantity integer,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_item public.order_items%rowtype;
  v_order public.orders%rowtype;
  v_sale public.inventory_movements%rowtype;
  v_confirmation_id uuid;
  v_note text := coalesce(trim(p_note), '');
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then
    raise exception 'ADMIN_REQUIRED';
  end if;
  if coalesce(p_received_quantity, 0) <= 0
     or coalesce(p_restock_quantity, -1) < 0
     or coalesce(p_scrap_quantity, -1) < 0
     or p_restock_quantity + p_scrap_quantity <> p_received_quantity then
    raise exception 'INVALID_RETURN_QUANTITY';
  end if;

  select * into v_item
    from public.order_items
   where id = p_order_item_id
   for update;
  if not found then raise exception 'ORDER_ITEM_NOT_FOUND'; end if;
  if p_received_quantity > v_item.quantity then raise exception 'RETURN_EXCEEDS_SOLD_QUANTITY'; end if;

  select * into v_order
    from public.orders
   where id = v_item.order_id
   for update;
  if v_order.status <> 'refunded' then raise exception 'RETURN_REQUIRES_REFUNDED_ORDER'; end if;

  select * into v_sale
    from public.inventory_movements
   where order_id = v_item.order_id
     and variant_id = v_item.variant_id
     and kind = 'sale'
   order by created_at, id
   limit 1
   for update;
  if not found then raise exception 'SALE_MOVEMENT_NOT_FOUND'; end if;
  if abs(v_sale.quantity_delta) < p_received_quantity then raise exception 'RETURN_EXCEEDS_SALE_MOVEMENT'; end if;
  if exists (
    select 1 from public.inventory_return_confirmations
     where order_item_id = v_item.id or sale_movement_id = v_sale.id
  ) then raise exception 'RETURN_ALREADY_CONFIRMED'; end if;
  if exists (
    select 1 from public.inventory_movements
     where source_movement_id = v_sale.id and kind = 'refund'
  ) then raise exception 'SALE_ALREADY_RESTOCKED'; end if;

  insert into public.inventory_return_confirmations(
    order_id, order_item_id, sale_movement_id,
    received_quantity, restock_quantity, scrap_quantity, note, actor_id
  )
  values (
    v_item.order_id, v_item.id, v_sale.id,
    p_received_quantity, p_restock_quantity, p_scrap_quantity, v_note, p_actor_id
  )
  returning id into v_confirmation_id;

  if p_restock_quantity > 0 then
    update public.product_variants
       set stock_on_hand = stock_on_hand + p_restock_quantity,
           updated_at = now()
     where id = v_item.variant_id;
    insert into public.inventory_movements(
      variant_id, order_id, kind, quantity_delta, reason, actor_id,
      source_movement_id, return_confirmation_id
    )
    values (
      v_item.variant_id,
      v_item.order_id,
      'refund',
      p_restock_quantity,
      '退貨驗收 ' || v_order.order_number || ' 可再售回補',
      p_actor_id,
      v_sale.id,
      v_confirmation_id
    );
  end if;

  return jsonb_build_object(
    'id', v_confirmation_id,
    'order_id', v_item.order_id,
    'order_item_id', v_item.id,
    'received_quantity', p_received_quantity,
    'restock_quantity', p_restock_quantity,
    'scrap_quantity', p_scrap_quantity
  );
exception
  when unique_violation then
    raise exception 'RETURN_ALREADY_CONFIRMED';
end;
$function$;

revoke all on function public.admin_transition_order(uuid,uuid,public.order_status,text)
  from public, anon, authenticated;
grant execute on function public.admin_transition_order(uuid,uuid,public.order_status,text) to service_role;
revoke all on function public.admin_confirm_order_return(uuid,uuid,integer,integer,integer,text)
  from public, anon, authenticated;
grant execute on function public.admin_confirm_order_return(uuid,uuid,integer,integer,integer,text) to service_role;

comment on table public.inventory_return_confirmations is
  '退款後實際收到退貨的正式驗收紀錄；可再售才回補 stock_on_hand，報廢數量只留不可變更紀錄';
comment on function public.admin_confirm_order_return(uuid,uuid,integer,integer,integer,text) is
  '管理員確認 refunded 訂單退貨收到數量，分為可再售與不可售；每個原 sale/order_item 只能確認一次';

create or replace function public.admin_dashboard_stats(p_actor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then
    raise exception 'ADMIN_REQUIRED';
  end if;

  return jsonb_build_object(
    'pendingReview', (select count(*) from public.orders where status = 'pending_review'),
    'sellerPending', (select count(*) from public.orders where status = 'pending_payment' and delivery_method = 'seller_delivery' and bank_account_id is null),
    'preorderSellerPending', (select count(*) from public.orders where status = 'pending_payment' and delivery_method = 'seller_delivery' and bank_account_id is not null),
    'readyForPickup', (
      select count(*)
        from public.orders o
       where o.status = 'ready_for_pickup'
         and (o.delivery_method = 'home_delivery'
           or (o.delivery_method = 'store_pickup' and exists (
             select 1 from public.order_items oi where oi.order_id = o.id and oi.kind = 'preorder'
           )))
    ),
    'lowStock', (select count(*) from public.product_variants where stock_on_hand <= safety_stock),
    'memberCount', (select count(*) from public.profiles)
  );
end;
$function$;

revoke all on function public.admin_dashboard_stats(uuid) from public, anon, authenticated;
grant execute on function public.admin_dashboard_stats(uuid) to service_role;

commit;
