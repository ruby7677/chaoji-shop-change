-- 潮吉好頑：初始商品、會員、庫存與訂單資料模型。
create extension if not exists pgcrypto;

create type public.product_kind as enum ('in_stock', 'preorder');
create type public.order_status as enum ('pending_payment', 'pending_review', 'confirmed', 'partially_ready', 'ready_for_pickup', 'completed', 'cancelled', 'refund_pending', 'refunded');
create type public.inventory_movement_kind as enum ('stock_in', 'sale', 'release', 'adjustment', 'refund');
create type public.point_entry_kind as enum ('earn', 'redeem', 'reversal', 'manual');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  line_user_id text unique,
  full_name text,
  phone text,
  birthday date,
  address text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profile_required_fields check (((full_name is null) = (phone is null)) and (full_name is null or (char_length(trim(full_name)) > 0 and char_length(trim(phone)) > 0)))
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  display_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references public.categories(id) on delete set null,
  name text not null,
  description text not null default '',
  is_published boolean not null default false,
  display_order integer not null default 0,
  purchase_limit integer check (purchase_limit is null or purchase_limit > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  name text not null default '單一規格',
  sku text not null unique,
  kind public.product_kind not null default 'in_stock',
  price integer not null check (price >= 0),
  cost integer check (cost is null or cost >= 0),
  stock_on_hand integer not null default 0 check (stock_on_hand >= 0),
  safety_stock integer not null default 3 check (safety_stock >= 0),
  preorder_arrival text,
  deposit_rate numeric(5,4) not null default 0 check (deposit_rate >= 0 and deposit_rate <= 1),
  seller_link text,
  is_published boolean not null default false,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint preorder_deposit_rule check ((kind = 'preorder' and deposit_rate = 0.5) or kind = 'in_stock')
);

create table public.inventory_reservations (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.product_variants(id) on delete restrict,
  order_id uuid,
  quantity integer not null check (quantity > 0),
  expires_at timestamptz not null,
  released_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  bank_name text not null,
  account_name text not null,
  account_number text not null,
  is_active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique,
  member_id uuid not null references public.profiles(id) on delete restrict,
  status public.order_status not null default 'pending_payment',
  pickup_plan text not null check (pickup_plan in ('together', 'split')),
  subtotal integer not null check (subtotal >= 0),
  coupon_discount integer not null default 0 check (coupon_discount >= 0),
  point_discount integer not null default 0 check (point_discount >= 0),
  amount_due integer not null check (amount_due >= 0),
  deposit_due integer not null check (deposit_due >= 0),
  payment_deadline timestamptz not null,
  payment_last_five text check (payment_last_five is null or payment_last_five ~ '^[0-9]{5}$'),
  bank_account_id uuid,
  admin_note text not null default '',
  confirmed_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.inventory_reservations add constraint inventory_reservations_order_id_fkey foreign key (order_id) references public.orders(id) on delete cascade;
alter table public.orders add constraint orders_bank_account_id_fkey foreign key (bank_account_id) references public.bank_accounts(id) on delete set null;

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  variant_id uuid not null references public.product_variants(id) on delete restrict,
  product_name text not null,
  variant_name text not null,
  unit_price integer not null check (unit_price >= 0),
  quantity integer not null check (quantity > 0),
  kind public.product_kind not null,
  deposit_rate numeric(5,4) not null,
  arrival_snapshot text,
  created_at timestamptz not null default now()
);

create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.product_variants(id) on delete restrict,
  order_id uuid references public.orders(id) on delete set null,
  kind public.inventory_movement_kind not null,
  quantity_delta integer not null,
  reason text not null,
  actor_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.point_ledger (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.profiles(id) on delete restrict,
  order_id uuid references public.orders(id) on delete set null,
  kind public.point_entry_kind not null,
  points integer not null check (points <> 0),
  reason text not null,
  actor_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create view public.storefront_variants with (security_invoker = true) as
select v.id::text, c.name as category, p.name || case when v.name = '單一規格' then '' else ' · ' || v.name end as name,
  v.price, greatest(v.stock_on_hand - coalesce((select sum(r.quantity) from public.inventory_reservations r where r.variant_id = v.id and r.released_at is null and r.expires_at > now()), 0), 0) as stock,
  case when v.kind = 'in_stock' then '現貨' else '預購' end as type, v.preorder_arrival, v.seller_link, v.display_order, v.is_published
from public.product_variants v join public.products p on p.id = v.product_id left join public.categories c on c.id = p.category_id;

grant select on public.storefront_variants to anon, authenticated;

alter table public.profiles enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.product_variants enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.inventory_reservations enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.point_ledger enable row level security;
alter table public.bank_accounts enable row level security;

create or replace function public.current_user_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select coalesce((select is_admin from public.profiles where id = auth.uid()), false) $$;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

create trigger create_profile_after_signup
after insert on auth.users
for each row execute function public.handle_new_auth_user();

create policy "public can view published storefront" on public.products for select using (is_published);
create policy "public can view categories" on public.categories for select using (true);
create policy "public can view published variants" on public.product_variants for select using (is_published);
create policy "members view own profile" on public.profiles for select using (auth.uid() = id);
create policy "members update own profile" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id and is_admin = public.current_user_is_admin());
create policy "members view own orders" on public.orders for select using (member_id = auth.uid());
create policy "members view own order items" on public.order_items for select using (exists (select 1 from public.orders o where o.id = order_id and o.member_id = auth.uid()));

revoke update on public.profiles from authenticated;
grant update (full_name, phone, birthday, address) on public.profiles to authenticated;

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
  if p_pickup_plan not in ('together', 'split') then raise exception 'INVALID_PICKUP_PLAN'; end if;
  if p_coupon_discount < 0 or p_point_discount < 0 then raise exception 'INVALID_DISCOUNT'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'EMPTY_CART'; end if;

  for v_item in select * from jsonb_to_recordset(p_items) as x(variant_id uuid, quantity integer) loop
    if v_item.quantity is null or v_item.quantity < 1 then raise exception 'INVALID_QUANTITY'; end if;
    select v.*, p.name as product_name, p.is_published, c.name as category_name
      into v_variant
      from public.product_variants v join public.products p on p.id = v.product_id left join public.categories c on c.id = p.category_id
      where v.id = v_item.variant_id and v.is_published = true and p.is_published = true
      for update of v;
    if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
    select v_variant.stock_on_hand - coalesce(sum(r.quantity) filter (where r.released_at is null and r.expires_at > now()), 0)
      into v_available from public.inventory_reservations r where r.variant_id = v_variant.id;
    if v_available < v_item.quantity then raise exception 'INSUFFICIENT_STOCK'; end if;
    v_subtotal := v_subtotal + v_variant.price * v_item.quantity;
    v_deposit := v_deposit + round(v_variant.price * v_item.quantity * v_variant.deposit_rate);
  end loop;
  v_amount := greatest(v_subtotal - p_coupon_discount - p_point_discount, 0);
  v_deposit := least(greatest(v_deposit - p_coupon_discount - p_point_discount, 0), v_amount);

  insert into public.orders(id, order_number, member_id, status, pickup_plan, subtotal, coupon_discount, point_discount, amount_due, deposit_due, payment_deadline, bank_account_id, payment_last_five)
    values (v_order_id, v_order_number, v_member_id, 'pending_payment', p_pickup_plan, v_subtotal, p_coupon_discount, p_point_discount, v_amount, v_deposit, now() + interval '24 hours', p_bank_account_id, p_payment_last_five);
  for v_item in select * from jsonb_to_recordset(p_items) as x(variant_id uuid, quantity integer) loop
    select v.*, p.name as product_name into v_variant from public.product_variants v join public.products p on p.id = v.product_id where v.id = v_item.variant_id;
    insert into public.order_items(order_id, variant_id, product_name, variant_name, unit_price, quantity, kind, deposit_rate, arrival_snapshot)
      values (v_order_id, v_variant.id, v_variant.product_name, v_variant.name, v_variant.price, v_item.quantity, v_variant.kind, v_variant.deposit_rate, v_variant.preorder_arrival);
    insert into public.inventory_reservations(variant_id, order_id, quantity, expires_at) values (v_variant.id, v_order_id, v_item.quantity, now() + interval '24 hours');
  end loop;
  return v_order_id;
end;
$$;

-- Security-definer functions must not retain the default PUBLIC execute grant.
revoke all on function public.current_user_is_admin() from public;
grant execute on function public.current_user_is_admin() to authenticated;
revoke all on function public.handle_new_auth_user() from public;
revoke all on function public.create_pending_order(jsonb, text, integer, integer, uuid, text) from public, anon;
grant execute on function public.create_pending_order(jsonb, text, integer, integer, uuid, text) to authenticated;
