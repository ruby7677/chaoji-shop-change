-- 潮吉好頑：宅配訂單收件人資料。
-- 宅配結帳除地址外，保存收件人姓名與收件人電話，供客服與後台出貨確認使用。

begin;

alter table public.orders
  add column if not exists shipping_recipient_name text,
  add column if not exists shipping_phone text;

comment on column public.orders.shipping_recipient_name is
  '宅配收件人姓名；僅宅配訂單使用';
comment on column public.orders.shipping_phone is
  '宅配收件人手機；僅宅配訂單使用';

-- 保留既有 8 參數函式供舊版前端相容；新版 Worker 使用此 10 參數函式。
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
  p_shipping_phone text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_phone text := regexp_replace(trim(coalesce(p_shipping_phone, '')), E'[\\s-]+', '', 'g');
begin
  if p_delivery_method = 'home_delivery' then
    if nullif(trim(coalesce(p_shipping_address, '')), '') is null then
      raise exception 'SHIPPING_ADDRESS_REQUIRED';
    end if;
    if nullif(trim(coalesce(p_shipping_recipient_name, '')), '') is null then
      raise exception 'SHIPPING_RECIPIENT_REQUIRED';
    end if;
    if v_phone !~ '^09[0-9]{8}$' then
      raise exception 'SHIPPING_PHONE_REQUIRED';
    end if;
  end if;

  v_order_id := public.create_delivery_order(
    p_items,
    p_pickup_plan,
    p_delivery_method,
    p_coupon_code,
    p_points_to_redeem,
    p_bank_account_id,
    p_payment_last_five,
    p_shipping_address
  );

  update public.orders
     set shipping_recipient_name = case when p_delivery_method = 'home_delivery' then trim(p_shipping_recipient_name) else null end,
         shipping_phone = case when p_delivery_method = 'home_delivery' then v_phone else null end,
         updated_at = now()
   where id = v_order_id
     and member_id = auth.uid();

  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;
  return v_order_id;
end;
$$;

revoke all on function public.create_delivery_order(jsonb, text, text, text, integer, uuid, text, text, text, text) from public, anon;
grant execute on function public.create_delivery_order(jsonb, text, text, text, integer, uuid, text, text, text, text) to authenticated;

commit;

