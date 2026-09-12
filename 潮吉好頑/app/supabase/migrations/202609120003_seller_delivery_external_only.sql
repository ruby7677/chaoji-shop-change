-- 潮吉好頑：賣貨便訂單必須在 7-ELEVEN 賣貨便完成。
-- 本站購物車只負責導向賣貨便，不在本站建立 seller_delivery 訂單。

begin;

create or replace function public.prevent_internal_seller_delivery_order()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.delivery_method = 'seller_delivery' then
    raise exception 'SELLER_DELIVERY_EXTERNAL_ONLY';
  end if;
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1
      from pg_trigger
     where tgname = 'orders_seller_delivery_external_only'
       and tgrelid = 'public.orders'::regclass
       and not tgisinternal
  ) then
    create trigger orders_seller_delivery_external_only
    before insert on public.orders
    for each row execute function public.prevent_internal_seller_delivery_order();
  end if;
end;
$$;

comment on function public.prevent_internal_seller_delivery_order() is
  '賣貨便訂單由 7-ELEVEN 賣貨便完成，不在本站建立訂單';

revoke all on function public.prevent_internal_seller_delivery_order() from public, anon, authenticated;

commit;

