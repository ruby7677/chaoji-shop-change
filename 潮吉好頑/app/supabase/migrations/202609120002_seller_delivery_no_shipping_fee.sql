-- 潮吉好頑：賣貨便運費不納入本站訂單。
-- 7-11 會在取貨時向客戶收取賣貨便運費；本站只記錄商品與尾款金額。

begin;

create or replace function public.enforce_seller_delivery_no_shipping_fee()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.delivery_method = 'seller_delivery' and coalesce(new.shipping_fee, 0) <> 0 then
    raise exception 'SELLER_DELIVERY_NO_SHIPPING_FEE';
  end if;
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1
      from pg_trigger
     where tgname = 'orders_seller_delivery_shipping_fee'
       and tgrelid = 'public.orders'::regclass
       and not tgisinternal
  ) then
    create trigger orders_seller_delivery_shipping_fee
    before insert or update of delivery_method, shipping_fee on public.orders
    for each row execute function public.enforce_seller_delivery_no_shipping_fee();
  end if;
end;
$$;

comment on function public.enforce_seller_delivery_no_shipping_fee() is
  '賣貨便運費由 7-11 向客戶收取，不得加入本站訂單金額';

revoke all on function public.enforce_seller_delivery_no_shipping_fee() from public, anon, authenticated;

commit;
