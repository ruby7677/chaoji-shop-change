-- 後台訂單分類改版（ORDER_STAGE_FILTER_PLAN.md）：全部｜待付訂｜待訂金對帳｜待到貨｜已通知待尾款確認｜待出貨｜已完成｜失效訂單。
-- 已通知待尾款確認＝交貨便／宅配預購已發到貨通知、尾款未確認（含會員已回報末五碼）；徽章只算已回報、待管理員對帳的筆數（balanceReported）。
-- 1. private.admin_order_stage：每筆訂單的後台分類（唯一定義；前台 public/admin-order-stages.js 鏡像，測試比對）。
--    不新增訂單狀態：尾款確認後仍是到貨狀態，依 final_payment_confirmed_at 歸到「待出貨」。
-- 2. admin_search_order_ids 接受分類值；舊的狀態值（confirmed、ready_for_pickup、seller_pending…）照舊可用，
--    讓 Worker 部署前的後台不會壞。
-- 3. admin_dashboard_stats 保留既有欄位，新增 readyToShip、balanceReported 與 stageCounts（未結案訂單各分類筆數）。

create or replace function private.admin_order_stage(p_order public.orders)
returns text
language sql
stable
set search_path = ''
as $function$
  select case
    when p_order.status::text in ('pending_payment', 'pending_review', 'completed') then p_order.status::text
    when p_order.status::text in ('cancelled', 'refund_pending', 'refunded') then 'cancelled'
    when not exists (select 1 from public.order_items oi where oi.order_id = p_order.id and oi.kind = 'preorder') then 'ready_to_ship'
    when p_order.status::text = 'confirmed' then 'awaiting_arrival'
    -- 預購到貨：交貨便／宅配要收尾款；尾款已確認，或已收齊（交貨便運費固定、宅配運費已確認）就待出貨
    when p_order.delivery_method in ('cvs_delivery', 'home_delivery')
      and p_order.final_payment_confirmed_at is null
      and not (p_order.paid_amount >= p_order.amount_due
        and (p_order.delivery_method = 'cvs_delivery' or p_order.shipping_fee_notified_at is not null))
      then 'awaiting_balance'
    else 'ready_to_ship'
  end
$function$;

revoke all on function private.admin_order_stage(public.orders) from public, anon, authenticated;

create or replace function public.admin_search_order_ids(
  p_actor_id uuid, p_query text default '', p_status text default 'all', p_page integer default 0, p_page_size integer default 100
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_query text := trim(coalesce(p_query, '')); v_status text := lower(trim(coalesce(p_status, 'all'))); v_page integer := greatest(least(coalesce(p_page, 0), 100000), 0); v_size integer := greatest(1, least(coalesce(p_page_size, 100), 100)); v_ids uuid[]; v_more boolean;
  v_stages constant text[] := array['pending_payment','pending_review','awaiting_arrival','awaiting_balance','ready_to_ship','completed','cancelled'];
  v_legacy constant text[] := array['confirmed','partially_ready','ready_for_pickup','refund_pending','refunded'];
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if not (v_status = 'all' or v_status = 'seller_pending' or v_status = any(v_stages) or v_status = any(v_legacy)) then raise exception 'INVALID_ADMIN_ORDER_FILTER'; end if;
  -- E'\\' evaluates to one backslash: the ESCAPE character must be exactly one byte.
  v_query := replace(replace(replace(v_query, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_');
  select coalesce(array_agg(s.id), '{}'::uuid[]) into v_ids
    from (
      select o.id
        from public.orders o
        left join public.profiles p on p.id = o.member_id
       where (v_status = 'all'
           or (v_status = 'seller_pending' and o.delivery_method = 'seller_delivery' and o.status = 'pending_payment' and o.bank_account_id is null)
           or (v_status = any(v_legacy) and o.status::text = v_status)
           or (v_status = any(v_stages) and private.admin_order_stage(o) = v_status))
         and (v_query = ''
           or o.order_number ilike '%' || v_query || '%' escape E'\\'
           or coalesce(o.payment_last_five, '') ilike '%' || v_query || '%' escape E'\\'
           or coalesce(o.final_payment_reported_last_five, '') ilike '%' || v_query || '%' escape E'\\'
           or coalesce(p.full_name, '') ilike '%' || v_query || '%' escape E'\\'
           or coalesce(p.phone, '') ilike '%' || v_query || '%' escape E'\\'
           or exists (
             select 1 from public.order_items oi
              where oi.order_id = o.id
                and (oi.product_name ilike '%' || v_query || '%' escape E'\\' or coalesce(oi.variant_name, '') ilike '%' || v_query || '%' escape E'\\')
           ))
       order by o.created_at desc, o.id desc
       limit v_size + 1 offset v_page * v_size
    ) s;
  v_more := cardinality(v_ids) > v_size;
  if v_more then v_ids := v_ids[1:v_size]; end if;
  return jsonb_build_object('ids', to_jsonb(v_ids), 'pagination', jsonb_build_object('page', v_page, 'pageSize', v_size, 'hasMore', v_more));
end;
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
    -- 概況統計卡「待出貨」（取代舊的「待取貨」卡；readyForPickup 保留給部署前的舊後台）
    'readyToShip', (select count(*) from public.orders o where o.status in ('confirmed', 'partially_ready', 'ready_for_pickup') and private.admin_order_stage(o) = 'ready_to_ship'),
    -- 「已通知待尾款確認」的徽章：會員已回報尾款末五碼、等管理員確認入帳
    'balanceReported', (select count(*) from public.orders o where o.status in ('partially_ready', 'ready_for_pickup') and o.final_payment_reported_at is not null and private.admin_order_stage(o) = 'awaiting_balance'),
    'stageCounts', (
      select coalesce(jsonb_object_agg(s.stage, s.n), '{}'::jsonb)
        from (
          select private.admin_order_stage(o) as stage, count(*) as n
            from public.orders o
           where o.status::text not in ('completed', 'cancelled', 'refund_pending', 'refunded')
           group by 1
        ) s
    ),
    'lowStock', (select count(*) from public.low_stock_variants()),
    'memberCount', (select count(*) from public.profiles)
  );
end;
$function$;

revoke all on function public.admin_search_order_ids(uuid, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.admin_search_order_ids(uuid, text, text, integer, integer) to service_role;
revoke all on function public.admin_dashboard_stats(uuid) from public, anon, authenticated;
grant execute on function public.admin_dashboard_stats(uuid) to service_role;
