-- 潮吉好頑：單筆訂單不再提供「一次／分批取貨」選項。
-- 現貨與預購由購物車分組後各自建立訂單；保留欄位僅供既有資料相容。

begin;

do $$
declare
  v_definition text;
  v_old text := 'if p_pickup_plan not in (''together'', ''split'') then raise exception ''INVALID_PICKUP_PLAN''; end if;';
  v_new text := 'if p_pickup_plan <> ''together'' then raise exception ''INVALID_PICKUP_PLAN''; end if;';
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
  '建立單一商品類型訂單；不接受單筆分批取貨，現貨與預購須分開建立';

commit;
