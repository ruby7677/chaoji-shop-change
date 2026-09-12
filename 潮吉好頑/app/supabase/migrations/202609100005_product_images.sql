-- 潮吉好頑：商品照片儲存與前台圖片資訊。
-- 前置需求：202609100004_member_points.sql。
-- 圖片 bucket 保持私有，由 Cloudflare Worker 驗證與代理讀取。
-- 可重複執行。

begin;

alter table public.products
  add column if not exists image_path text,
  add column if not exists image_updated_at timestamptz;

comment on column public.products.image_path is '私有 product-images bucket 內的物件路徑';
comment on column public.products.image_updated_at is '圖片版本時間，用於前台快取更新';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images',
  'product-images',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

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
  p.image_updated_at
from public.product_variants v
join public.products p on p.id = v.product_id
left join public.categories c on c.id = p.category_id;

grant select on public.storefront_variants to anon, authenticated;

commit;
