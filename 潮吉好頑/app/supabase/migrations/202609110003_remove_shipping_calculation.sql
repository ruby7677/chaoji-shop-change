-- 潮吉好頑：運費改由客服到貨後通知，不在下單時估算或加總。
-- 保留 orders.shipping_fee 欄位供既有訂單歷史使用；新訂單固定寫入 0。

begin;

-- create_delivery_order 仍以既有簽名呼叫此函式，因此保留相容函式，
-- 但不再讀取任何運費設定，所有取貨方式皆回傳 0。
create or replace function public.calculate_shipping_fee(
  p_delivery_method text,
  p_shipping_units integer
)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_delivery_method not in ('store_pickup', 'seller_delivery', 'home_delivery') then
    raise exception 'INVALID_DELIVERY_METHOD';
  end if;
  return 0;
end;
$$;

-- 後台不再維護運費級距與固定費用；設定表改名保留歷史資料，避免誤刪設定紀錄。
drop function if exists public.admin_update_shipping_settings(uuid, integer, integer, integer, integer, integer);
alter table if exists public.shipping_settings rename to shipping_settings_legacy;

revoke all on function public.calculate_shipping_fee(text, integer) from public, anon, authenticated;
grant execute on function public.calculate_shipping_fee(text, integer) to authenticated;

commit;
