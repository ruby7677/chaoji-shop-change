-- 示範資料：正式上線前可刪除或由管理端重新建立。
insert into public.categories (name, display_order) values
  ('BX系列', 10), ('UX系列', 20)
on conflict (name) do nothing;

insert into public.products (category_id, name, description, is_published, display_order)
select c.id, x.name, x.description, true, x.display_order
from (values
  ('BX系列', 'BX35抽抽包 亞洲版', '現貨商品。', 10),
  ('UX系列', 'UX20 榮耀戰神 亞洲版', '現貨商品。', 20)
) as x(category, name, description, display_order)
join public.categories c on c.name = x.category
where not exists (select 1 from public.products p where p.name = x.name);

insert into public.product_variants (product_id, name, sku, kind, price, stock_on_hand, safety_stock, seller_link, is_published, display_order)
select p.id, '單一規格', x.sku, 'in_stock', x.price, x.stock, 3, 'https://myship.7-11.com.tw/cart/confirm/GM2606221488922', true, x.display_order
from (values
  ('BX35抽抽包 亞洲版', 'CJ-BX35-ASIA', 1300, 8, 10),
  ('UX20 榮耀戰神 亞洲版', 'CJ-UX20-ASIA', 1350, 23, 20)
) as x(name, sku, price, stock, display_order)
join public.products p on p.name = x.name
where not exists (select 1 from public.product_variants v where v.sku = x.sku);
