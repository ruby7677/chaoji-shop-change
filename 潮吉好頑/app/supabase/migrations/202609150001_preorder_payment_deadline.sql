-- 潮吉好頑：預購訂單付款期限改為成立後 2 小時。
-- 現貨匯款仍保留 24 小時；現貨賣貨便外部待確認訂單維持既有 store_payment 期限。

begin;

do $$
declare
  v_definition text;
  v_old text := 'v_payment_deadline := now() + case when v_store_payment then interval ''3 months'' else interval ''24 hours'' end;';
  v_new text := 'v_payment_deadline := now() + case when v_store_payment then interval ''3 months'' when v_has_preorder then interval ''2 hours'' else interval ''24 hours'' end;';
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
  '建立本站訂單；預購匯款期限 2 小時，現貨匯款期限 24 小時，seller_delivery 保留外部付款流程';

commit;
