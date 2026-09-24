-- 規格層優惠原價：price 保留為實際售價，compare_at_price 僅供前後台顯示原價與限時優惠。
-- 訂單、庫存、點數與折扣計算仍只使用 product_variants.price。

begin;

alter table public.product_variants
  add column if not exists compare_at_price integer;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.product_variants'::regclass
       and conname = 'product_variants_compare_at_price_nonnegative'
  ) then
    alter table public.product_variants
      add constraint product_variants_compare_at_price_nonnegative
      check (compare_at_price is null or compare_at_price >= 0);
  end if;
end;
$$;

comment on column public.product_variants.compare_at_price is
  '優惠顯示用原價；只有大於 price 時才顯示刪除線與限時優惠標籤，不參與訂單計算';

create or replace view public.storefront_variants with (security_invoker = true) as
select
  v.id::text,
  c.name as category,
  p.name || case when v.name = '單一規格' then '' else ' · ' || v.name end as name,
  v.price,
  private.storefront_available_stock(v.id) as stock,
  case when v.kind = 'in_stock' then '現貨' else '預購' end as type,
  v.preorder_arrival,
  v.seller_link,
  v.display_order,
  v.is_published,
  p.id::text as product_id,
  (p.image_path is not null) as has_image,
  p.image_updated_at,
  v.shipping_units,
  p.name as product_name,
  p.description,
  v.name as variant_name,
  p.purchase_limit,
  p.points_eligible,
  v.compare_at_price
from public.product_variants v
join public.products p on p.id = v.product_id
left join public.categories c on c.id = p.category_id;

revoke all on public.storefront_variants from anon, authenticated;
grant select on public.storefront_variants to anon, authenticated;

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
  p_points_eligible boolean default true,
  p_compare_at_price integer default null
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
  if p_compare_at_price is not null and p_compare_at_price < 0 then raise exception 'INVALID_COMPARE_AT_PRICE'; end if;
  if p_compare_at_price is not null and p_compare_at_price < p_price then raise exception 'COMPARE_AT_PRICE_BELOW_PRICE'; end if;
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
    product_id, name, sku, kind, price, compare_at_price, stock_on_hand, preorder_arrival,
    deposit_rate, seller_link, is_published, display_order
  ) values (
    v_product_id,
    coalesce(nullif(trim(p_variant_name), ''), '單一規格'),
    upper(trim(p_sku)),
    p_kind,
    p_price,
    p_compare_at_price,
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

revoke all on function public.admin_create_product(
  uuid, text, text, text, text, text, public.product_kind,
  integer, integer, text, numeric, text, boolean, integer, boolean
) from public, anon, authenticated, service_role;
revoke all on function public.admin_create_product(
  uuid, text, text, text, text, text, public.product_kind,
  integer, integer, text, numeric, text, boolean, integer, boolean, integer
) from public, anon, authenticated;
grant execute on function public.admin_create_product(
  uuid, text, text, text, text, text, public.product_kind,
  integer, integer, text, numeric, text, boolean, integer, boolean, integer
) to service_role;

commit;
