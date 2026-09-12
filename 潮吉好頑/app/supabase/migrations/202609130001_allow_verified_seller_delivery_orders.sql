-- 潮吉好頑：賣貨便改為「本站待確認 → 管理員核對 → 確認扣庫存」流程。
-- 會員在購物車點擊賣貨便後，本站先建立 pending_payment 訂單，
-- 管理員與賣貨便外部訂單核對後，再將本站訂單更新為 confirmed。

begin;

-- 移除先前禁止本站建立賣貨便訂單的 trigger；保留既有歷史訂單。
drop trigger if exists orders_seller_delivery_external_only on public.orders;

-- 讓 seller_delivery + 無銀行帳戶的訂單走與到店支付相同的待確認流程。
-- 以目前資料庫中的函式定義為基礎，只放寬 delivery method 判斷，避免複製整段下單計算邏輯。
do $$
declare
  v_definition text;
  v_old text := 'p_delivery_method <> ''store_pickup''';
  v_new text := 'p_delivery_method not in (''store_pickup'', ''seller_delivery'')';
begin
  select pg_get_functiondef(p.oid)
    into v_definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'create_delivery_order'
     and p.oid = 'public.create_delivery_order(jsonb,text,text,text,integer,uuid,text,text)'::regprocedure;

  if v_definition is null then
    raise exception 'CREATE_DELIVERY_ORDER_FUNCTION_NOT_FOUND';
  end if;
  if position(v_old in v_definition) = 0 then
    raise exception 'CREATE_DELIVERY_ORDER_FUNCTION_SHAPE_CHANGED';
  end if;

  execute replace(v_definition, v_old, v_new);
end;
$$;

comment on function public.create_delivery_order(jsonb, text, text, text, integer, uuid, text, text) is
  '建立本站訂單；seller_delivery 需由管理員核對賣貨便外部訂單後確認並扣庫存';

commit;
