-- 會員在網站回報尾款匯款末五碼（預購店到店／宅配到貨後），供管理員核對：
-- 1. orders 新增 final_payment_reported_last_five／final_payment_reported_at。與管理員確認時輸入的
--    final_payment_last_five 分開：admin_update_order_fulfillment 每次未勾確認儲存都會把 final_payment_last_five 清成 null。
-- 2. submit_order_final_payment：只有本人、含預購、店到店或宅配、已到貨（partially_ready／ready_for_pickup）、
--    匯款訂單、尾款未確認且尚有未收金額的訂單可回報；宅配另須運費已確認。確認前可改填，以最後一次為準。
--    訂單狀態不變（到貨後的狀態不可改回 pending_review：確認時會再扣一次庫存，也會被逾期排程取消）。
-- 到店取貨不在範圍內：取貨完成即視為付清，沒有尾款確認步驟。

alter table public.orders
  add column if not exists final_payment_reported_last_five text
    check (final_payment_reported_last_five is null or final_payment_reported_last_five ~ '^[0-9]{5}$'),
  add column if not exists final_payment_reported_at timestamptz;

comment on column public.orders.final_payment_reported_last_five is
  '會員在網站回報的尾款匯款末五碼（最後一次），供管理員核對；管理員確認時另存 final_payment_last_five';
comment on column public.orders.final_payment_reported_at is
  '會員最後一次回報尾款末五碼的時間；通知以此區分每次回報';

create or replace function public.submit_order_final_payment(
  p_order_id uuid,
  p_payment_last_five text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null then raise exception 'LOGIN_REQUIRED'; end if;
  if p_payment_last_five is null or p_payment_last_five !~ '^[0-9]{5}$' then
    raise exception 'INVALID_PAYMENT_LAST_FIVE';
  end if;

  update public.orders o
     set final_payment_reported_last_five = p_payment_last_five,
         final_payment_reported_at = now(),
         updated_at = now()
   where o.id = p_order_id
     and o.member_id = auth.uid()
     and o.delivery_method in ('cvs_delivery', 'home_delivery')
     and o.status in ('partially_ready', 'ready_for_pickup')
     and o.bank_account_id is not null
     and o.final_payment_confirmed_at is null
     and o.amount_due > o.paid_amount
     and (o.delivery_method <> 'home_delivery' or o.shipping_fee_notified_at is not null)
     and exists (select 1 from public.order_items oi where oi.order_id = o.id and oi.kind = 'preorder');

  if not found then raise exception 'FINAL_PAYMENT_NOT_REPORTABLE'; end if;
  return true;
end;
$function$;

revoke all on function public.submit_order_final_payment(uuid, text) from public, anon;
grant execute on function public.submit_order_final_payment(uuid, text) to authenticated;
