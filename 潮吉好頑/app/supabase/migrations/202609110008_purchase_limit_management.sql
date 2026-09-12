-- 潮吉好頑：管理後台商品限購數量設定。
-- products.purchase_limit 原本已存在，本 migration 補上建立商品 RPC 的寫入能力。

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
  p_is_published boolean,
  p_purchase_limit integer default null
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
  if p_purchase_limit is not null and p_purchase_limit < 1 then raise exception 'INVALID_PURCHASE_LIMIT'; end if;
  if p_deposit_rate < 0 or p_deposit_rate > 1 then raise exception 'INVALID_DEPOSIT_RATE'; end if;
  if p_kind = 'preorder' and p_deposit_rate <> 0.5 then raise exception 'PREORDER_DEPOSIT_MUST_BE_HALF'; end if;

  insert into public.categories(name, display_order)
  values (trim(p_category_name), coalesce((select max(display_order) + 10 from public.categories), 10))
  on conflict (name) do update set name = excluded.name
  returning id into v_category_id;

  insert into public.products(category_id, name, description, is_published, display_order, purchase_limit)
  values (
    v_category_id,
    trim(p_product_name),
    coalesce(p_description, ''),
    p_is_published,
    coalesce((select max(display_order) + 10 from public.products), 10),
    p_purchase_limit
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

revoke all on function public.admin_create_product(uuid, text, text, text, text, text, public.product_kind, integer, integer, text, numeric, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.admin_create_product(uuid, text, text, text, text, text, public.product_kind, integer, integer, text, numeric, text, boolean, integer) to service_role;

commit;
