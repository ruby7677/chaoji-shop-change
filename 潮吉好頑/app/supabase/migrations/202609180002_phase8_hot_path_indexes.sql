-- Phase 8: indexes for confirmed hot paths only.
-- Do not modify already-applied migrations. These indexes match current
-- cleanup, reservation, catalog-join, coupon and admin-list predicates.
begin;

create index if not exists orders_pending_deadline_idx
  on public.orders (payment_deadline)
  where status in ('pending_payment', 'pending_review');

create index if not exists inventory_reservations_order_active_idx
  on public.inventory_reservations (order_id)
  where released_at is null;

create index if not exists inventory_reservations_variant_active_expiry_idx
  on public.inventory_reservations (variant_id, expires_at)
  where released_at is null;

create index if not exists order_items_variant_idx
  on public.order_items (variant_id);

create index if not exists product_variants_product_idx
  on public.product_variants (product_id);

create index if not exists products_category_idx
  on public.products (category_id);

create index if not exists coupon_members_member_idx
  on public.coupon_members (member_id);

create index if not exists coupon_products_product_idx
  on public.coupon_products (product_id);

create index if not exists coupon_redemptions_member_idx
  on public.coupon_redemptions (member_id);

create index if not exists inventory_movements_created_idx
  on public.inventory_movements (created_at desc);

commit;
