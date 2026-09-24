-- 潮吉好頑：現貨與預購必須分開建立訂單，避免付款期限、庫存與通知流程混用。

begin;

do $$
declare
  v_definition text;
  v_old_flags text := 'v_has_preorder boolean := false;';
  v_new_flags text := 'v_has_preorder boolean := false;
  v_has_in_stock boolean := false;';
  v_old_kind text := 'if v_variant.kind = ''preorder'' then v_has_preorder := true; end if;';
  v_new_kind text := 'if v_variant.kind = ''preorder'' then v_has_preorder := true; else v_has_in_stock := true; end if;';
  v_old_guard text := 'if v_store_payment and v_has_preorder then raise exception ''STORE_PAYMENT_PREORDER_NOT_ALLOWED''; end if;';
  v_new_guard text := 'if v_has_preorder and v_has_in_stock then raise exception ''MIXED_ORDER_NOT_ALLOWED''; end if;
  if v_store_payment and v_has_preorder then raise exception ''STORE_PAYMENT_PREORDER_NOT_ALLOWED''; end if;';
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
  if position('MIXED_ORDER_NOT_ALLOWED' in v_definition) > 0 then
    return;
  end if;
  if position(v_old_flags in v_definition) = 0
     or position(v_old_kind in v_definition) = 0
     or position(v_old_guard in v_definition) = 0 then
    raise exception 'CREATE_DELIVERY_ORDER_FUNCTION_SHAPE_CHANGED';
  end if;

  v_definition := replace(v_definition, v_old_flags, v_new_flags);
  v_definition := replace(v_definition, v_old_kind, v_new_kind);
  v_definition := replace(v_definition, v_old_guard, v_new_guard);
  execute v_definition;
end;
$$;

comment on function public.create_delivery_order(jsonb, text, text, text, integer, uuid, text, text) is
  '建立單一商品類型訂單；現貨與預購混購須由前台分組後分開建立';

commit;
