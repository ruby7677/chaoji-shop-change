-- 潮吉好頑：本站訂單付款方式改為僅接受匯款／轉帳。
-- 到店取貨與宅配不再接受到店現金支付；賣貨便仍保留外部付款的 store_payment 內部標記。

begin;

do $$
declare
  v_definition text;
  v_old text := 'if v_store_payment and p_delivery_method not in (''store_pickup'', ''seller_delivery'') then raise exception ''STORE_PAYMENT_ONLY_STORE_PICKUP''; end if;';
  v_new text := 'if v_store_payment and p_delivery_method <> ''seller_delivery'' then raise exception ''STORE_PAYMENT_BANK_TRANSFER_ONLY''; end if;';
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
  if position(v_new in v_definition) > 0 then
    return;
  end if;
  if position(v_old in v_definition) = 0 then
    raise exception 'CREATE_DELIVERY_ORDER_FUNCTION_SHAPE_CHANGED';
  end if;

  execute replace(v_definition, v_old, v_new);
end;
$$;

comment on function public.create_delivery_order(jsonb, text, text, text, integer, uuid, text, text) is
  '建立本站訂單；到店取貨與宅配僅接受匯款／轉帳，seller_delivery 保留外部付款流程';

commit;
