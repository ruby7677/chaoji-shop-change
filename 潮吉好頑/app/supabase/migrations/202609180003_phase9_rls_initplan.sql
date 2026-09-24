-- Phase 9: cache request identity once per statement and remove the
-- duplicate member-cart SELECT policy. This preserves the existing policy
-- roles and ownership checks; it only changes evaluation shape.
begin;

alter policy "members view own profile" on public.profiles
  using ((select auth.uid()) = id);

alter policy "members update own profile" on public.profiles
  using ((select auth.uid()) = id)
  with check (
    (select auth.uid()) = id
    and is_admin = (select public.current_user_is_admin())
  );

alter policy "members view own orders" on public.orders
  using (member_id = (select auth.uid()));

alter policy "members view own order items" on public.order_items
  using (
    exists (
      select 1
      from public.orders o
      where o.id = order_items.order_id
        and o.member_id = (select auth.uid())
    )
  );

-- The FOR ALL policy already covers SELECT with the same predicate.
drop policy if exists "members view own cart" on public.member_cart_items;

commit;
