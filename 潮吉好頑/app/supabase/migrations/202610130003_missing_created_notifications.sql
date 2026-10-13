-- 潮吉好頑：找出缺少建單通知的訂單（Worker src/order-created-sweep.ts 每 5 分鐘呼叫）。
-- 資料庫已建單、但 Worker 沒收到 RPC 回應（逾時、斷線）時，POST /api/orders 不會觸發建單通知。
-- 由資料庫直接比對每位預期收件人有沒有 created:<訂單 id> 的通知紀錄，Worker 不必翻頁掃描，也不會被已通知的訂單卡住。
-- 預期收件人：LINE 啟用時為會員綁定的 LINE；另加呼叫端傳入的 Telegram 管理員（設定在 Worker 環境變數）。
-- 只回仍待付款、宅配運費尚未通知、付款期限未到的訂單，依付款期限由近到遠，最急的先補。

begin;

create or replace function public.missing_created_notifications(
  p_since timestamptz,
  p_until timestamptz,
  p_line_enabled boolean,
  p_telegram_recipients text[],
  p_limit integer
)
returns table (order_id uuid, line_user_id text)
language sql
stable
security definer
set search_path = ''
as $function$
  select o.id, case when p_line_enabled then nullif(p.line_user_id, '') end
    from public.orders o
    left join public.profiles p on p.id = o.member_id
   where o.status = 'pending_payment'
     and o.shipping_fee_notified_at is null
     and o.payment_deadline > now()
     and o.created_at >= p_since
     and o.created_at <= p_until
     and (
       (p_line_enabled
        and nullif(p.line_user_id, '') is not null
        and not exists (
          select 1 from public.notification_deliveries d
           where d.channel = 'line' and d.event_key = 'created:' || o.id and d.recipient_id = p.line_user_id))
       or exists (
         select 1 from unnest(coalesce(p_telegram_recipients, '{}'::text[])) r(recipient_id)
          where nullif(r.recipient_id, '') is not null
            and not exists (
            select 1 from public.notification_deliveries d
             where d.channel = 'telegram' and d.event_key = 'created:' || o.id and d.recipient_id = r.recipient_id))
     )
   order by o.payment_deadline, o.created_at, o.id
   limit greatest(least(coalesce(p_limit, 0), 50), 0)
$function$;

revoke all on function public.missing_created_notifications(timestamptz, timestamptz, boolean, text[], integer) from public, anon, authenticated;
grant execute on function public.missing_created_notifications(timestamptz, timestamptz, boolean, text[], integer) to service_role;

comment on function public.missing_created_notifications(timestamptz, timestamptz, boolean, text[], integer) is
  '建單通知補發：仍待付款且有預期收件人缺 created 通知紀錄的訂單（依付款期限排序）；僅 service_role 可執行（202610130003）';

commit;
