-- 潮吉好頑：建單冪等。
-- 建單已 commit 但回應在網路上遺失時，客人重送同一次結帳不能再建第二筆訂單、再保留一次庫存或再扣點數／占用優惠券。
-- 前端每次結帳嘗試帶 client_request_id（內容不變的重試沿用同一個值）；同會員同 key 已有訂單時直接回傳原訂單 id。
-- 只靠 insert … on conflict 不夠：建單核心在 INSERT 前已檢查庫存、優惠券、點數，INSERT 時又有待付款筆數與好友驗證限制，
-- 重試可能在碰到唯一約束前就被拒絕。所以先以會員＋key 取交易級 advisory lock，查到原單就直接返回，查不到才進入既有建單流程。
-- 既有 8／10／14 參數入口保持不變（部署期間舊 Worker 仍會呼叫 14 參數版）。

begin;

alter table public.orders
  add column if not exists client_request_id uuid,
  add column if not exists client_request_fingerprint text;

comment on column public.orders.client_request_id is
  '前端結帳嘗試識別碼；同會員同值的重試回傳同一筆訂單（202610130001）';
comment on column public.orders.client_request_fingerprint is
  '建單請求內容的雜湊；同 key 但內容不同的請求會被拒絕';

create unique index if not exists orders_member_client_request_key
  on public.orders (member_id, client_request_id)
  where client_request_id is not null;

-- 會員建單入口（15 參數）：14 參數版加上 p_client_request_id。
create or replace function public.create_delivery_order(
  p_items jsonb,
  p_pickup_plan text,
  p_delivery_method text,
  p_coupon_code text,
  p_points_to_redeem integer,
  p_bank_account_id uuid,
  p_payment_last_five text,
  p_shipping_address text,
  p_shipping_recipient_name text,
  p_shipping_phone text,
  p_pickup_store_city text,
  p_pickup_store_district text,
  p_pickup_store_name text,
  p_pickup_store_code text,
  p_client_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_member_id uuid := auth.uid();
  v_fingerprint text;
  v_existing_id uuid;
  v_existing_fingerprint text;
  v_order_id uuid;
begin
  if p_client_request_id is null then
    return public.create_delivery_order(
      p_items, p_pickup_plan, p_delivery_method, p_coupon_code, p_points_to_redeem,
      p_bank_account_id, p_payment_last_five, p_shipping_address, p_shipping_recipient_name, p_shipping_phone,
      p_pickup_store_city, p_pickup_store_district, p_pickup_store_name, p_pickup_store_code
    );
  end if;
  if v_member_id is null then raise exception 'LOGIN_REQUIRED'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' then raise exception 'EMPTY_CART'; end if;

  -- 與 14 參數版相同的正規化，避免空白或電話格式差異被當成不同請求。
  v_fingerprint := md5(jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_array(lower(e->>'variant_id'), e->>'quantity') order by lower(e->>'variant_id'), e->>'quantity')
        from jsonb_array_elements(p_items) e
    ), '[]'::jsonb),
    'pickup_plan', p_pickup_plan,
    'delivery_method', p_delivery_method,
    'coupon', nullif(upper(trim(coalesce(p_coupon_code, ''))), ''),
    'points', coalesce(p_points_to_redeem, 0),
    'bank', p_bank_account_id,
    'last_five', p_payment_last_five,
    'address', nullif(trim(coalesce(p_shipping_address, '')), ''),
    'recipient', nullif(trim(coalesce(p_shipping_recipient_name, '')), ''),
    'phone', regexp_replace(trim(coalesce(p_shipping_phone, '')), '[\s-]+', '', 'g'),
    'store_city', nullif(trim(coalesce(p_pickup_store_city, '')), ''),
    'store_district', nullif(trim(coalesce(p_pickup_store_district, '')), ''),
    'store_name', nullif(trim(coalesce(p_pickup_store_name, '')), ''),
    'store_code', regexp_replace(coalesce(p_pickup_store_code, ''), '\s+', '', 'g')
  )::text);

  -- 同會員同 key 的並發請求在此排隊；先到者 commit 後，後到者會讀到它建立的訂單。
  perform pg_advisory_xact_lock(hashtextextended(v_member_id::text || ':' || p_client_request_id::text, 0));

  select o.id, o.client_request_fingerprint
    into v_existing_id, v_existing_fingerprint
    from public.orders o
   where o.member_id = v_member_id
     and o.client_request_id = p_client_request_id;
  if found then
    -- 原單不論目前狀態（含已取消）都回傳原 id，不改寫、不重新保留。
    if v_existing_fingerprint is distinct from v_fingerprint then raise exception 'CLIENT_REQUEST_CONFLICT'; end if;
    return v_existing_id;
  end if;

  v_order_id := public.create_delivery_order(
    p_items, p_pickup_plan, p_delivery_method, p_coupon_code, p_points_to_redeem,
    p_bank_account_id, p_payment_last_five, p_shipping_address, p_shipping_recipient_name, p_shipping_phone,
    p_pickup_store_city, p_pickup_store_district, p_pickup_store_name, p_pickup_store_code
  );

  update public.orders
     set client_request_id = p_client_request_id,
         client_request_fingerprint = v_fingerprint
   where id = v_order_id
     and member_id = v_member_id;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  return v_order_id;
end;
$function$;

revoke all on function public.create_delivery_order(jsonb, text, text, text, integer, uuid, text, text, text, text, text, text, text, text, uuid) from public, anon;
grant execute on function public.create_delivery_order(jsonb, text, text, text, integer, uuid, text, text, text, text, text, text, text, text, uuid) to authenticated;

comment on function public.create_delivery_order(jsonb, text, text, text, integer, uuid, text, text, text, text, text, text, text, text, uuid) is
  '會員建單入口（冪等）：同會員同 client_request_id 回傳原訂單；內容不同則 CLIENT_REQUEST_CONFLICT';

commit;
