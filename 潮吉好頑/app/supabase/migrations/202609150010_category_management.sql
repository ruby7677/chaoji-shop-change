-- 潮吉好頑：商品分類管理。
-- 分類仍屬於商品層級；停用只會阻止新商品選用，不影響既有商品的分類顯示。

begin;

alter table public.categories
  add column if not exists is_active boolean not null default true;

create index if not exists categories_active_order_idx
  on public.categories (is_active, display_order, name);

commit;
