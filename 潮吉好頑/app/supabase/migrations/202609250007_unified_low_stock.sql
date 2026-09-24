-- 潮吉好頑：低庫存判定統一為單一來源。
-- 原本三處各自判斷：後台統計（admin_dashboard_stats）與後台低庫存清單計入未上架規格，
-- 低庫存通知只看已上架規格。店主決定一律「商品與規格都上架中，且實際庫存 ≤ 安全庫存」。
-- low_stock_variants 為唯一定義：後台統計、後台清單與 Telegram 低庫存通知都由它取得。

begin;

create or replace function public.low_stock_variants(p_limit integer default null)
returns table (
  id uuid,
  name text,
  sku text,
  product_name text,
  stock_on_hand integer,
  safety_stock integer
)
language sql
stable
security definer
set search_path = ''
as $function$
  select v.id, v.name, v.sku, p.name, v.stock_on_hand, v.safety_stock
    from public.product_variants v
    join public.products p on p.id = v.product_id
   where v.is_published
     and p.is_published
     and v.stock_on_hand <= v.safety_stock
   order by v.stock_on_hand, v.id
   limit greatest(coalesce(p_limit, 10000), 1);
$function$;

create or replace function public.admin_dashboard_stats(p_actor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then
    raise exception 'ADMIN_REQUIRED';
  end if;

  return jsonb_build_object(
    'pendingReview', (select count(*) from public.orders where status = 'pending_review'),
    'sellerPending', (select count(*) from public.orders where status = 'pending_payment' and delivery_method = 'seller_delivery' and bank_account_id is null),
    'preorderSellerPending', (select count(*) from public.orders where status = 'pending_payment' and delivery_method = 'seller_delivery' and bank_account_id is not null),
    'readyForPickup', (
      select count(*)
        from public.orders o
       where o.status = 'ready_for_pickup'
         and (o.delivery_method = 'home_delivery'
           or (o.delivery_method = 'store_pickup' and exists (
             select 1 from public.order_items oi where oi.order_id = o.id and oi.kind = 'preorder'
           )))
    ),
    'lowStock', (select count(*) from public.low_stock_variants()),
    'memberCount', (select count(*) from public.profiles)
  );
end;
$function$;

revoke all on function public.low_stock_variants(integer) from public, anon, authenticated;
grant execute on function public.low_stock_variants(integer) to service_role;
revoke all on function public.admin_dashboard_stats(uuid) from public, anon, authenticated;
grant execute on function public.admin_dashboard_stats(uuid) to service_role;

comment on function public.low_stock_variants(integer) is
  '低庫存唯一定義：商品與規格皆上架且 stock_on_hand <= safety_stock，依庫存由低到高；後台統計／清單與低庫存通知共用';

commit;
