-- 通知營運列表補充安全顯示 context。
-- 僅用已知訂單事件前綴＋canonical UUID 回查訂單；生日券、低庫存、測試事件不猜訂單。

begin;

create or replace function public.admin_list_notification_deliveries(
  p_actor_id uuid,
  p_channel text default 'all',
  p_status text default 'all',
  p_page integer default 0,
  p_page_size integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_channel text := lower(trim(coalesce(p_channel, 'all')));
  v_status text := lower(trim(coalesce(p_status, 'all')));
  v_page integer := greatest(least(coalesce(p_page, 0), 100000), 0);
  v_size integer := greatest(1, least(coalesce(p_page_size, 50), 100));
  v_items jsonb;
  v_more boolean;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if v_channel not in ('all', 'line', 'telegram') then raise exception 'INVALID_NOTIFICATION_CHANNEL'; end if;
  if v_status not in ('all', 'pending', 'processing', 'sent', 'failed') then raise exception 'INVALID_NOTIFICATION_STATUS'; end if;

  with deliveries as (
    select l.id, 'line'::text as channel, l.event_key, l.event_type,
      coalesce(p.full_name, 'LINE 會員') as recipient_name,
      o.order_number,
      case when length(l.recipient_id) <= 4 then repeat('*', length(l.recipient_id))
           else left(l.recipient_id, 2) || repeat('*', least(12, length(l.recipient_id) - 4)) || right(l.recipient_id, 2) end as recipient_hint,
      l.status, l.attempt_count, l.last_status_code, l.error_message, l.failure_kind,
      l.next_retry_at, l.last_attempt_at, l.created_at, l.updated_at
      from public.line_notification_logs l
      left join public.profiles p on p.line_user_id = l.recipient_id
      left join public.orders o on o.id = case
        when l.event_key ~ '^(created|payment_reported|status_changed|fulfillment_updated):[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(:|$)'
          then substring(l.event_key from '^[^:]+:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})')::uuid
        else null
      end
    union all
    select t.id, 'telegram'::text as channel, t.event_key, t.event_type,
      '管理員 Telegram' as recipient_name,
      o.order_number,
      case when length(t.recipient_id) <= 4 then repeat('*', length(t.recipient_id))
           else left(t.recipient_id, 2) || repeat('*', least(12, length(t.recipient_id) - 4)) || right(t.recipient_id, 2) end as recipient_hint,
      t.status, t.attempt_count, t.last_status_code, t.error_message, t.failure_kind,
      t.next_retry_at, t.last_attempt_at, t.created_at, t.updated_at
      from public.telegram_notification_logs t
      left join public.orders o on o.id = case
        when t.event_key ~ '^(created|payment_reported|status_changed|fulfillment_updated):[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(:|$)'
          then substring(t.event_key from '^[^:]+:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})')::uuid
        else null
      end
  )
  select coalesce(jsonb_agg(to_jsonb(s) order by s.updated_at desc, s.id desc), '[]'::jsonb)
    into v_items
    from (
      select * from deliveries
       where (v_channel = 'all' or channel = v_channel)
         and (v_status = 'all' or status = v_status)
       order by updated_at desc, id desc
       limit v_size + 1 offset v_page * v_size
    ) s;

  v_more := jsonb_array_length(v_items) > v_size;
  if v_more then
    select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb)
      into v_items
      from jsonb_array_elements(v_items) with ordinality
     where ordinality <= v_size;
  end if;
  return jsonb_build_object(
    'items', v_items,
    'pagination', jsonb_build_object('page', v_page, 'pageSize', v_size, 'hasMore', v_more)
  );
end;
$function$;

revoke all on function public.admin_list_notification_deliveries(uuid,text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.admin_list_notification_deliveries(uuid,text,text,integer,integer) to service_role;

comment on function public.admin_list_notification_deliveries(uuid,text,text,integer,integer) is
  '通知列表補充遮罩收件人 hint、LINE 會員姓名與已知訂單事件的訂單編號；非訂單 event_key 保留 null';

commit;
