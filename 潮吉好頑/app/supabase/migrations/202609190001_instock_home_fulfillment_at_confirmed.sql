-- 現貨宅配付款確認後，不再要求先更新「現貨已備貨完成」狀態。
-- 管理員可在 confirmed 直接填寫實際運費／尾款末五碼；預購宅配仍須先進入到貨狀態。

begin;

do $migration$
declare
  v_definition text;
  v_old text := $old$if v_order.status not in ('partially_ready', 'ready_for_pickup') then
      raise exception 'FINAL_PAYMENT_NOT_ALLOWED';
    end if;$old$;
  v_new text := $new$if v_order.status not in ('partially_ready', 'ready_for_pickup')
       and not (
         v_order.status = 'confirmed'
         and v_order.delivery_method = 'home_delivery'
         and not exists (
           select 1
           from public.order_items oi
           where oi.order_id = v_order.id
             and oi.kind = 'preorder'
         )
       ) then
      raise exception 'FINAL_PAYMENT_NOT_ALLOWED';
    end if;$new$;
begin
  select pg_get_functiondef('public.admin_update_order_fulfillment(uuid,uuid,integer,boolean,text,text)'::regprocedure)
    into v_definition;
  if v_definition is null then
    raise exception 'ADMIN_UPDATE_ORDER_FULFILLMENT_FUNCTION_NOT_FOUND';
  end if;
  if position(v_old in v_definition) = 0 then
    raise exception 'ADMIN_UPDATE_ORDER_FULFILLMENT_FUNCTION_SHAPE_CHANGED';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$migration$;

comment on function public.admin_update_order_fulfillment(uuid, uuid, integer, boolean, text, text) is
  '管理員更新尾款與實際運費；現貨宅配付款確認後可直接填寫，預購宅配需先到貨';

commit;
