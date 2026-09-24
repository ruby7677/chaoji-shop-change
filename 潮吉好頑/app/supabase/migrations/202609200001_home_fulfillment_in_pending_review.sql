-- 現貨宅配在「待確認款項」階段先保存實際運費與全額匯款末五碼，
-- 管理員接著確認款項並扣除庫存；預購宅配仍需先到貨。

begin;

do $migration$
declare
  v_definition text;
  v_old text := $old$if v_order.status not in ('partially_ready', 'ready_for_pickup')
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
    end if;$old$;
  v_new text := $new$if v_order.status not in ('partially_ready', 'ready_for_pickup')
       and not (
         v_order.status in ('confirmed', 'pending_review')
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
  if v_definition is null or position(v_old in v_definition) = 0 then
    raise exception 'ADMIN_UPDATE_ORDER_FULFILLMENT_FUNCTION_SHAPE_CHANGED';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$migration$;

do $migration$
declare
  v_definition text;
  v_old text := $old$paid_amount = case when p_target_status = 'confirmed' then deposit_due when p_target_status = 'completed' then amount_due else paid_amount end,$old$;
  v_new text := $new$paid_amount = case
           when p_target_status = 'confirmed' then case when v_order.final_payment_confirmed_at is not null then amount_due else deposit_due end
           when p_target_status = 'completed' then amount_due
           else paid_amount
         end,$new$;
begin
  select pg_get_functiondef('public.admin_transition_order(uuid,uuid,public.order_status,text)'::regprocedure)
    into v_definition;
  if v_definition is null or position(v_old in v_definition) = 0 then
    raise exception 'ADMIN_TRANSITION_ORDER_FUNCTION_SHAPE_CHANGED';
  end if;
  execute replace(v_definition, v_old, v_new);
end;
$migration$;

comment on function public.admin_update_order_fulfillment(uuid, uuid, integer, boolean, text, text) is
  '現貨宅配在待確認款項階段保存運費與全額匯款末五碼；預購宅配需先到貨';

commit;
