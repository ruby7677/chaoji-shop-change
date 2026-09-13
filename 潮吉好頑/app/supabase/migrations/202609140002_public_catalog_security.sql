-- 潮吉好頑：公開商品 view 的安全庫存聚合修正。
-- 202609140001 收緊了 inventory_reservations 的前端 table grant；
-- 公開 view 改由 private security-definer 函式計算可售量，不暴露 reservation 明細。

begin;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated;

create or replace function private.storefront_available_stock(p_variant_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(
    v.stock_on_hand - coalesce((
      select sum(r.quantity)
      from public.inventory_reservations r
      where r.variant_id = v.id
        and r.released_at is null
        and r.expires_at > current_timestamp
    ), 0),
    0
  )
  from public.product_variants v
  join public.products p on p.id = v.product_id
  where v.id = p_variant_id
    and v.is_published
    and p.is_published;
$$;

revoke all on function private.storefront_available_stock(uuid) from public, anon, authenticated;
grant execute on function private.storefront_available_stock(uuid) to anon, authenticated;

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
  p.purchase_limit
from public.product_variants v
join public.products p on p.id = v.product_id
left join public.categories c on c.id = p.category_id;

revoke all on public.storefront_variants from anon, authenticated;
grant select on public.storefront_variants to anon, authenticated;

commit;
