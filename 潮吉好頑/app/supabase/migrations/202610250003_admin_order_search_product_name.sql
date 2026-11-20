-- 後台訂單搜尋加上商品名稱：關鍵字也比對訂單明細的商品名稱與規格名稱（order_items 建單時的快照，商品改名後仍可用舊名找到）。
-- 其餘條件（訂單編號、末五碼、會員姓名、手機、狀態篩選、分頁）與 202609220004 相同。
create or replace function public.admin_search_order_ids(
  p_actor_id uuid, p_query text default '', p_status text default 'all', p_page integer default 0, p_page_size integer default 100
)
returns jsonb
language plpgsql security definer set search_path = ''
as $function$
declare v_query text := trim(coalesce(p_query, '')); v_status text := lower(trim(coalesce(p_status, 'all'))); v_page integer := greatest(least(coalesce(p_page, 0), 100000), 0); v_size integer := greatest(1, least(coalesce(p_page_size, 100), 100)); v_ids uuid[]; v_more boolean;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if v_status not in ('all','seller_pending','pending_payment','pending_review','confirmed','partially_ready','ready_for_pickup','completed','cancelled','refund_pending','refunded') then raise exception 'INVALID_ADMIN_ORDER_FILTER'; end if;
  -- E'\\' evaluates to one backslash: the ESCAPE character must be exactly one byte.
  v_query := replace(replace(replace(v_query, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_');
  select coalesce(array_agg(s.id), '{}'::uuid[]) into v_ids
    from (
      select o.id
        from public.orders o
        left join public.profiles p on p.id = o.member_id
       where (v_status = 'all' or (v_status = 'seller_pending' and o.delivery_method = 'seller_delivery' and o.status = 'pending_payment' and o.bank_account_id is null) or (v_status not in ('all','seller_pending') and o.status::text = v_status))
         and (v_query = ''
           or o.order_number ilike '%' || v_query || '%' escape E'\\'
           or coalesce(o.payment_last_five, '') ilike '%' || v_query || '%' escape E'\\'
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
