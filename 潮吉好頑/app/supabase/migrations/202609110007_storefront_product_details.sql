-- 潮吉好頑：前台商品詳情與多規格選擇所需的公開目錄欄位。
-- 保留既有 storefront_variants 欄位順序，新增欄位附加於最後。

begin;

create or replace view public.storefront_variants with (security_invoker = true) as
select
  v.id::text,
  c.name as category,
  p.name || case when v.name = '單一規格' then '' else ' · ' || v.name end as name,
  v.price,
  greatest(
    v.stock_on_hand - coalesce((
      select sum(r.quantity)
      from public.inventory_reservations r
      where r.variant_id = v.id
        and r.released_at is null
        and r.expires_at > now()
    ), 0),
    0
  ) as stock,
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

grant select on public.storefront_variants to anon, authenticated;

commit;
