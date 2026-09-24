-- 潮吉好頑：預購商品可選賣貨便，但先在本站以匯款支付訂金。
-- 現貨賣貨便仍使用外部賣貨便取貨付款；賣貨便＋本站匯款僅允許預購商品。

begin;

do $$
declare
  v_definition text;
  v_old text := 'if v_store_payment and v_has_preorder then raise exception ''STORE_PAYMENT_PREORDER_NOT_ALLOWED''; end if;';
  v_new text := 'if v_store_payment and v_has_preorder then raise exception ''STORE_PAYMENT_PREORDER_NOT_ALLOWED''; end if;
  if p_delivery_method = ''seller_delivery'' and not v_store_payment and not v_has_preorder then raise exception ''SELLER_BANK_PREORDER_ONLY''; end if;';
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
  if position('SELLER_BANK_PREORDER_ONLY' in v_definition) > 0 then
    return;
  end if;
  if position(v_old in v_definition) = 0 then
    raise exception 'CREATE_DELIVERY_ORDER_FUNCTION_SHAPE_CHANGED';
  end if;

  execute replace(v_definition, v_old, v_new);
end;
$$;

comment on function public.create_delivery_order(jsonb, text, text, text, integer, uuid, text, text) is
  '建立本站訂單；預購賣貨便先匯款付訂，現貨賣貨便維持外部取貨付款核對流程';

commit;
