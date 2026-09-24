-- 商品積點資格：商品層級設定、訂單明細快照、完成訂單時計算。
-- 既有商品／既有 order_items 皆以 true 保留歷史語意。

begin;

alter table public.products
  add column if not exists points_eligible boolean not null default true;

alter table public.order_items
  add column if not exists points_eligible_snapshot boolean not null default true;

comment on column public.products.points_eligible is
  '商品完成訂單時是否列入會員新點數累積；使用者仍可使用既有點數折抵';
comment on column public.order_items.points_eligible_snapshot is
  '建立訂單時快照的商品積點資格；歷史訂單不隨商品目前設定變動';

create or replace function public.snapshot_order_item_points_eligibility()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  select coalesce(p.points_eligible, true)
    into new.points_eligible_snapshot
    from public.product_variants v
    join public.products p on p.id = v.product_id
   where v.id = new.variant_id;
  if not found then
    raise exception 'ORDER_ITEM_VARIANT_NOT_FOUND';
  end if;
  return new;
end;
$$;

revoke all on function public.snapshot_order_item_points_eligibility() from public, anon, authenticated;
grant execute on function public.snapshot_order_item_points_eligibility() to service_role;

drop trigger if exists order_items_snapshot_points_eligibility on public.order_items;
create trigger order_items_snapshot_points_eligibility
before insert on public.order_items
for each row execute function public.snapshot_order_item_points_eligibility();

create or replace function public.apply_points_from_order_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_earn_amount integer;
  v_eligible_item_subtotal integer;
  v_points integer;
  v_balance_from_order integer;
begin
  select * into v_order from public.orders where id = new.order_id;
  if not found then return new; end if;

  if new.to_status = 'completed' and new.from_status <> 'completed' then
    select earn_amount_per_point into v_earn_amount from public.point_settings where id;
    if v_earn_amount is null or v_earn_amount <= 0 then return new; end if;

    select coalesce(sum(oi.unit_price * oi.quantity) filter (where oi.points_eligible_snapshot), 0)::integer
      into v_eligible_item_subtotal
      from public.order_items oi
     where oi.order_id = v_order.id;

    v_points := floor(greatest(
      v_eligible_item_subtotal
      - coalesce(v_order.coupon_discount, 0)
      - coalesce(v_order.point_discount, 0),
      0
    )::numeric / v_earn_amount)::integer;

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

-- 15 參數版本把商品積點資格寫進 products；既有舊版本不再提供 service_role execute，避免 RPC ambiguity。
create or replace function public.admin_create_product(
  p_actor_id uuid,
  p_category_name text,
  p_product_name text,
  p_description text,
  p_variant_name text,
  p_sku text,
  p_kind public.product_kind,
  p_price integer,
  p_stock integer,
  p_preorder_arrival text,
  p_deposit_rate numeric,
  p_seller_link text,
  p_is_published boolean,
  p_purchase_limit integer default null,
  p_points_eligible boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_category_id uuid;
  v_product_id uuid;
  v_variant_id uuid;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then
    raise exception 'ADMIN_REQUIRED';
  end if;
  if nullif(trim(p_category_name), '') is null or nullif(trim(p_product_name), '') is null or nullif(trim(p_sku), '') is null then
    raise exception 'REQUIRED_FIELDS_MISSING';
  end if;
  if p_price < 0 or p_stock < 0 then raise exception 'INVALID_NUMBER'; end if;
  if p_purchase_limit is not null and p_purchase_limit < 1 then raise exception 'INVALID_PURCHASE_LIMIT'; end if;
  if p_deposit_rate < 0 or p_deposit_rate > 1 then raise exception 'INVALID_DEPOSIT_RATE'; end if;
  if p_kind = 'preorder' and p_deposit_rate <> 0.5 then raise exception 'PREORDER_DEPOSIT_MUST_BE_HALF'; end if;

  insert into public.categories(name, display_order)
  values (trim(p_category_name), coalesce((select max(display_order) + 10 from public.categories), 10))
  on conflict (name) do update set name = excluded.name
  returning id into v_category_id;

  insert into public.products(category_id, name, description, is_published, display_order, purchase_limit, points_eligible)
  values (
    v_category_id,
    trim(p_product_name),
    coalesce(p_description, ''),
    p_is_published,
    coalesce((select max(display_order) + 10 from public.products), 10),
    p_purchase_limit,
    coalesce(p_points_eligible, true)
  )
  returning id into v_product_id;

  insert into public.product_variants(
    product_id, name, sku, kind, price, stock_on_hand, preorder_arrival,
    deposit_rate, seller_link, is_published, display_order
  ) values (
    v_product_id,
    coalesce(nullif(trim(p_variant_name), ''), '單一規格'),
    upper(trim(p_sku)),
    p_kind,
    p_price,
    p_stock,
    nullif(trim(p_preorder_arrival), ''),
    p_deposit_rate,
    nullif(trim(p_seller_link), ''),
    p_is_published,
    10
  )
  returning id into v_variant_id;

  if p_stock > 0 then
    insert into public.inventory_movements(variant_id, kind, quantity_delta, reason, actor_id)
    values (v_variant_id, 'stock_in', p_stock, '建立商品初始庫存', p_actor_id);
  end if;

  return jsonb_build_object('product_id', v_product_id, 'variant_id', v_variant_id);
end;
$$;

revoke all on function public.admin_create_product(uuid, text, text, text, text, text, public.product_kind, integer, integer, text, numeric, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.admin_create_product(uuid, text, text, text, text, text, public.product_kind, integer, integer, text, numeric, text, boolean, integer) from public, anon, authenticated, service_role;
grant execute on function public.admin_create_product(uuid, text, text, text, text, text, public.product_kind, integer, integer, text, numeric, text, boolean, integer, boolean) to service_role;

commit;
