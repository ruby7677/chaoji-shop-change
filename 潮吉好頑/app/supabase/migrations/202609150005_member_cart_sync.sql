-- 潮吉好頑：會員購物車同步。
-- 訪客購物車仍由瀏覽器 sessionStorage 暫存；LINE 登入後由 Worker 同步至此表。

begin;

create table if not exists public.member_cart_items (
  member_id uuid not null references public.profiles(id) on delete cascade,
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  quantity integer not null check (quantity between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (member_id, variant_id)
);

create index if not exists member_cart_items_updated_at_idx
  on public.member_cart_items(member_id, updated_at desc);

alter table public.member_cart_items enable row level security;

drop policy if exists "members view own cart" on public.member_cart_items;
create policy "members view own cart"
  on public.member_cart_items for select
  to authenticated
  using ((select auth.uid()) = member_id);

drop policy if exists "members manage own cart" on public.member_cart_items;
create policy "members manage own cart"
  on public.member_cart_items for all
  to authenticated
  using ((select auth.uid()) = member_id)
  with check ((select auth.uid()) = member_id);

grant all on table public.member_cart_items to service_role;

comment on table public.member_cart_items is
  'LINE 會員跨裝置購物車；訂單建立後由前端刪除已結帳品項';

commit;
