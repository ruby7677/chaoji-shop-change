-- 潮吉好頑：賣貨便核對後比照到店取貨完成訂單。
-- 賣貨便款項在 7-ELEVEN 外部平台收取，不需要本站的尾款／運費確認欄位。

begin;

do $$
declare
  v_definition text;
  v_old text := 'and v_order.delivery_method <> ''store_pickup''';
  v_new text := 'and v_order.delivery_method = ''home_delivery''';
begin
  select pg_get_functiondef('public.admin_transition_order(uuid,uuid,public.order_status,text)'::regprocedure)
    into v_definition;

  if v_definition is null then
    raise exception 'ADMIN_TRANSITION_ORDER_FUNCTION_NOT_FOUND';
  end if;
  if position(v_old in v_definition) = 0 then
    raise exception 'ADMIN_TRANSITION_ORDER_FUNCTION_SHAPE_CHANGED';
  end if;

  execute replace(v_definition, v_old, v_new);
end;
$$;

comment on function public.admin_transition_order(uuid, uuid, public.order_status, text) is
  '管理員更新訂單狀態；宅配需確認尾款，賣貨便比照到店取貨由管理員核對後完成';

commit;

