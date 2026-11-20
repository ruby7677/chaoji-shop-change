-- 後台月份業績與訂單月份篩選。月份一律以台灣時間（Asia/Taipei）的建單日期切分，'all' 代表不限月份。
-- 1. admin_sales_summary：業績＝應付總額扣運費（商品小計扣掉優惠券與點數折抵）、已收、未收（含運費）；
--    待付訂（可能逾期取消）與失效訂單（已取消、退款中、已退款）不計入。另回傳有訂單的月份清單供下拉選單使用。
-- 2. admin_search_order_ids 新增 p_month（預設 'all'）：舊的 5 參數呼叫仍可對應；先移除舊簽名避免多載衝突。
begin;

-- 'all' 回傳 null；其餘必須是 YYYY-MM，回傳該月台灣時間的起訖時間
create or replace function private.admin_month_range(p_month text, out v_from timestamptz, out v_until timestamptz)
language plpgsql
stable
set search_path = ''
as $function$
declare
  v_month text := lower(trim(coalesce(p_month, 'all')));
begin
  if v_month = 'all' then return; end if;
  if v_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'INVALID_ADMIN_MONTH'; end if;
  v_from := (v_month || '-01')::timestamp at time zone 'Asia/Taipei';
  v_until := ((v_month || '-01')::timestamp + interval '1 month') at time zone 'Asia/Taipei';
end;
$function$;

revoke all on function private.admin_month_range(text) from public, anon, authenticated;

create or replace function public.admin_sales_summary(p_actor_id uuid, p_month text default 'all')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_range record;
  v_summary jsonb;
  v_months jsonb;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then
    raise exception 'ADMIN_REQUIRED';
  end if;
  select * into v_range from private.admin_month_range(p_month);

  select jsonb_build_object(
           'orderCount', count(*),
           'revenue', coalesce(sum(o.amount_due - coalesce(o.shipping_fee, 0)), 0),
           'received', coalesce(sum(o.paid_amount), 0),
           'outstanding', coalesce(sum(greatest(o.amount_due - o.paid_amount, 0)), 0)
         )
    into v_summary
    from public.orders o
   where o.status::text not in ('pending_payment', 'cancelled', 'refund_pending', 'refunded')
     and (v_range.v_from is null or (o.created_at >= v_range.v_from and o.created_at < v_range.v_until));

  -- 月份清單包含所有訂單（含失效），訂單頁篩選也用同一份
  select coalesce(jsonb_agg(m.month order by m.month desc), '[]'::jsonb)
    into v_months
    from (select distinct to_char(created_at at time zone 'Asia/Taipei', 'YYYY-MM') as month from public.orders) m;

  return v_summary || jsonb_build_object(
    'month', case when v_range.v_from is null then 'all' else to_char(v_range.v_from at time zone 'Asia/Taipei', 'YYYY-MM') end,
    'months', v_months
  );
end;
$function$;

revoke all on function public.admin_sales_summary(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_sales_summary(uuid, text) to service_role;
comment on function public.admin_sales_summary(uuid, text) is
  '後台月份業績（台灣時間建單月份；業績不含運費，未收含運費；不含待付訂與失效訂單）與有訂單的月份清單';

drop function if exists public.admin_search_order_ids(uuid, text, text, integer, integer);

create or replace function public.admin_search_order_ids(
  p_actor_id uuid, p_query text default '', p_status text default 'all', p_page integer default 0, p_page_size integer default 100,
  p_month text default 'all'
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_query text := trim(coalesce(p_query, '')); v_status text := lower(trim(coalesce(p_status, 'all'))); v_page integer := greatest(least(coalesce(p_page, 0), 100000), 0); v_size integer := greatest(1, least(coalesce(p_page_size, 100), 100)); v_ids uuid[]; v_more boolean;
  v_stages constant text[] := array['pending_payment','pending_review','awaiting_arrival','awaiting_balance','ready_to_ship','completed','cancelled'];
  v_legacy constant text[] := array['confirmed','partially_ready','ready_for_pickup','refund_pending','refunded'];
  v_range record;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if not (v_status = 'all' or v_status = 'seller_pending' or v_status = any(v_stages) or v_status = any(v_legacy)) then raise exception 'INVALID_ADMIN_ORDER_FILTER'; end if;
  select * into v_range from private.admin_month_range(p_month);
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
         and (v_range.v_from is null or (o.created_at >= v_range.v_from and o.created_at < v_range.v_until))
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

revoke all on function public.admin_search_order_ids(uuid, text, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.admin_search_order_ids(uuid, text, text, integer, integer, text) to service_role;
comment on function public.admin_search_order_ids(uuid, text, text, integer, integer, text) is
  '管理員訂單搜尋／狀態篩選／月份篩選（台灣時間建單月份）／分頁，回傳完整 order id 分頁結果';

commit;
