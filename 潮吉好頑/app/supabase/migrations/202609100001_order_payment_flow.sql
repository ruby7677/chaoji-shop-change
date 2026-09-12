-- 潮吉好頑：訂單付款回報與 24 小時逾期自動釋放。
-- 前置需求：202609080001_initial_schema.sql 與 202609090001_patch_after_initial_schema.sql。
-- 可重複執行。

begin;

-- 現貨規格的 deposit_rate = 0 代表須付全額；大於 0 時代表可付該比例訂金。
-- 預購規格仍由既有 constraint 固定為 50%。
create or replace function public.create_pending_order(
  p_items jsonb,
  p_pickup_plan text default 'together',
  p_coupon_discount integer default 0,
  p_point_discount integer default 0,
  p_bank_account_id uuid default null,
  p_payment_last_five text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member_id uuid := auth.uid();
  v_order_id uuid := gen_random_uuid();
  v_order_number text := 'CJ-' || to_char(now(), 'YYMMDD-HH24MISS') || '-' || upper(substr(replace(v_order_id::text, '-', ''), 1, 4));
  v_subtotal integer := 0;
  v_deposit integer := 0;
  v_amount integer;
  v_item record;
  v_variant record;
  v_available integer;
begin
  if v_member_id is null then raise exception 'LOGIN_REQUIRED'; end if;
  if not exists (select 1 from public.profiles where id = v_member_id and nullif(trim(full_name), '') is not null and nullif(trim(phone), '') is not null) then
    raise exception 'PROFILE_INCOMPLETE';
  end if;
  if p_pickup_plan not in ('together', 'split') then raise exception 'INVALID_PICKUP_PLAN'; end if;
  if p_coupon_discount < 0 or p_point_discount < 0 then raise exception 'INVALID_DISCOUNT'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'EMPTY_CART'; end if;
  if p_bank_account_id is null or not exists (select 1 from public.bank_accounts where id = p_bank_account_id and is_active) then
    raise exception 'BANK_ACCOUNT_REQUIRED';
  end if;
  if p_payment_last_five is not null and p_payment_last_five !~ '^[0-9]{5}$' then raise exception 'INVALID_PAYMENT_LAST_FIVE'; end if;

  for v_item in select * from jsonb_to_recordset(p_items) as x(variant_id uuid, quantity integer) loop
    if v_item.quantity is null or v_item.quantity < 1 then raise exception 'INVALID_QUANTITY'; end if;
    select v.*, p.name as product_name, p.is_published
      into v_variant
      from public.product_variants v
      join public.products p on p.id = v.product_id
      where v.id = v_item.variant_id and v.is_published = true and p.is_published = true
      for update of v;
    if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
    select v_variant.stock_on_hand - coalesce(sum(r.quantity) filter (where r.released_at is null and r.expires_at > now()), 0)
      into v_available from public.inventory_reservations r where r.variant_id = v_variant.id;
    if v_available < v_item.quantity then raise exception 'INSUFFICIENT_STOCK'; end if;
    v_subtotal := v_subtotal + v_variant.price * v_item.quantity;
    v_deposit := v_deposit + case
      when v_variant.kind = 'in_stock' and v_variant.deposit_rate = 0 then v_variant.price * v_item.quantity
      else round(v_variant.price * v_item.quantity * v_variant.deposit_rate)
    end;
  end loop;

  v_amount := greatest(v_subtotal - p_coupon_discount - p_point_discount, 0);
  v_deposit := least(greatest(v_deposit - p_coupon_discount - p_point_discount, 0), v_amount);

  insert into public.orders(id, order_number, member_id, status, pickup_plan, subtotal, coupon_discount, point_discount, amount_due, deposit_due, payment_deadline, bank_account_id, payment_last_five)
    values (v_order_id, v_order_number, v_member_id,
      case when p_payment_last_five is null then 'pending_payment'::public.order_status else 'pending_review'::public.order_status end,
      p_pickup_plan, v_subtotal, p_coupon_discount, p_point_discount, v_amount, v_deposit,
      now() + interval '24 hours', p_bank_account_id, p_payment_last_five);

  for v_item in select * from jsonb_to_recordset(p_items) as x(variant_id uuid, quantity integer) loop
    select v.*, p.name as product_name into v_variant
      from public.product_variants v join public.products p on p.id = v.product_id
      where v.id = v_item.variant_id;
    insert into public.order_items(order_id, variant_id, product_name, variant_name, unit_price, quantity, kind, deposit_rate, arrival_snapshot)
      values (v_order_id, v_variant.id, v_variant.product_name, v_variant.name, v_variant.price, v_item.quantity, v_variant.kind, v_variant.deposit_rate, v_variant.preorder_arrival);
    insert into public.inventory_reservations(variant_id, order_id, quantity, expires_at)
      values (v_variant.id, v_order_id, v_item.quantity, now() + interval '24 hours');
  end loop;
  return v_order_id;
end;
$$;

create or replace function public.submit_order_payment(
  p_order_id uuid,
  p_bank_account_id uuid,
  p_payment_last_five text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'LOGIN_REQUIRED'; end if;
  if p_payment_last_five !~ '^[0-9]{5}$' then raise exception 'INVALID_PAYMENT_LAST_FIVE'; end if;
  if not exists (select 1 from public.bank_accounts where id = p_bank_account_id and is_active) then
    raise exception 'INVALID_BANK_ACCOUNT';
  end if;

  update public.orders
     set bank_account_id = p_bank_account_id,
         payment_last_five = p_payment_last_five,
         status = 'pending_review',
         updated_at = now()
   where id = p_order_id
     and member_id = auth.uid()
     and status = 'pending_payment'
     and payment_deadline > now();

  if not found then raise exception 'ORDER_NOT_PAYABLE'; end if;
  return true;
end;
$$;

create or replace function public.cancel_expired_orders()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with expired as (
    update public.orders
       set status = 'cancelled', cancelled_at = now(), updated_at = now()
     where status = 'pending_payment' and payment_deadline <= now()
     returning id
  ), released as (
    update public.inventory_reservations r
       set released_at = now()
      from expired e
     where r.order_id = e.id and r.released_at is null
     returning r.id
  )
  select count(*) into v_count from expired;
  return v_count;
end;
$$;

revoke all on function public.create_pending_order(jsonb, text, integer, integer, uuid, text) from public, anon;
grant execute on function public.create_pending_order(jsonb, text, integer, integer, uuid, text) to authenticated;
revoke all on function public.submit_order_payment(uuid, uuid, text) from public, anon;
grant execute on function public.submit_order_payment(uuid, uuid, text) to authenticated;
revoke all on function public.cancel_expired_orders() from public, anon, authenticated;

commit;

-- Supabase Cron 以 UTC 執行；每分鐘清理到期的待付款訂單。
create extension if not exists pg_cron with schema pg_catalog;
select cron.unschedule(jobid) from cron.job where jobname = 'chaoji-release-expired-orders';
select cron.schedule(
  'chaoji-release-expired-orders',
  '* * * * *',
  'select public.cancel_expired_orders();'
);
