-- 潮吉好頑：管理後台商品建立與庫存調整交易函式。
-- 前置需求：202609080001_initial_schema.sql。
-- 可重複執行。

begin;

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
  p_is_published boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
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
  if p_deposit_rate < 0 or p_deposit_rate > 1 then raise exception 'INVALID_DEPOSIT_RATE'; end if;
  if p_kind = 'preorder' and p_deposit_rate <> 0.5 then raise exception 'PREORDER_DEPOSIT_MUST_BE_HALF'; end if;

  insert into public.categories(name, display_order)
  values (trim(p_category_name), coalesce((select max(display_order) + 10 from public.categories), 10))
  on conflict (name) do update set name = excluded.name
  returning id into v_category_id;

  insert into public.products(category_id, name, description, is_published, display_order)
  values (
    v_category_id,
    trim(p_product_name),
    coalesce(p_description, ''),
    p_is_published,
    coalesce((select max(display_order) + 10 from public.products), 10)
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

create or replace function public.admin_adjust_inventory(
  p_actor_id uuid,
  p_variant_id uuid,
  p_quantity_delta integer,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stock integer;
  v_reserved integer;
  v_new_stock integer;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then
    raise exception 'ADMIN_REQUIRED';
  end if;
  if p_quantity_delta = 0 then raise exception 'ZERO_ADJUSTMENT'; end if;
  if nullif(trim(p_reason), '') is null then raise exception 'REASON_REQUIRED'; end if;

  select stock_on_hand into v_stock
  from public.product_variants
  where id = p_variant_id
  for update;
  if not found then raise exception 'VARIANT_NOT_FOUND'; end if;

  select coalesce(sum(quantity), 0)::integer into v_reserved
  from public.inventory_reservations
  where variant_id = p_variant_id and released_at is null and expires_at > now();

  v_new_stock := v_stock + p_quantity_delta;
  if v_new_stock < 0 then raise exception 'NEGATIVE_STOCK'; end if;
  if v_new_stock < v_reserved then raise exception 'BELOW_RESERVED_STOCK'; end if;

  update public.product_variants
  set stock_on_hand = v_new_stock, updated_at = now()
  where id = p_variant_id;

  insert into public.inventory_movements(variant_id, kind, quantity_delta, reason, actor_id)
  values (p_variant_id, 'adjustment', p_quantity_delta, trim(p_reason), p_actor_id);

  return v_new_stock;
end;
$$;

revoke all on function public.admin_create_product(uuid, text, text, text, text, text, public.product_kind, integer, integer, text, numeric, text, boolean) from public, anon, authenticated;
grant execute on function public.admin_create_product(uuid, text, text, text, text, text, public.product_kind, integer, integer, text, numeric, text, boolean) to service_role;
revoke all on function public.admin_adjust_inventory(uuid, uuid, integer, text) from public, anon, authenticated;
grant execute on function public.admin_adjust_inventory(uuid, uuid, integer, text) to service_role;

commit;
