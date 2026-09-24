-- 通知營運後台：service_role-only 查詢與 failed 重試排程。
-- requeue 只改 retry state，不呼叫外部 LINE／Telegram API。

begin;

alter table public.audit_logs
  drop constraint if exists audit_logs_action_check,
  drop constraint if exists audit_logs_resource_check;

alter table public.audit_logs
  add constraint audit_logs_action_check
    check (action in ('create', 'update', 'adjust', 'upload', 'retry')),
  add constraint audit_logs_resource_check
    check (resource in ('product', 'product_variant', 'category', 'bank_account', 'coupon', 'birthday_coupon_settings', 'point_settings', 'member_points', 'product_image', 'notification_delivery'));

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
      case when length(l.recipient_id) <= 4 then repeat('*', length(l.recipient_id))
           else left(l.recipient_id, 2) || repeat('*', least(12, length(l.recipient_id) - 4)) || right(l.recipient_id, 2) end as recipient_hint,
      l.status, l.attempt_count, l.last_status_code, l.error_message, l.failure_kind,
      l.next_retry_at, l.last_attempt_at, l.created_at, l.updated_at
      from public.line_notification_logs l
    union all
    select t.id, 'telegram'::text as channel, t.event_key, t.event_type,
      case when length(t.recipient_id) <= 4 then repeat('*', length(t.recipient_id))
           else left(t.recipient_id, 2) || repeat('*', least(12, length(t.recipient_id) - 4)) || right(t.recipient_id, 2) end as recipient_hint,
      t.status, t.attempt_count, t.last_status_code, t.error_message, t.failure_kind,
      t.next_retry_at, t.last_attempt_at, t.created_at, t.updated_at
      from public.telegram_notification_logs t
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

create or replace function public.admin_requeue_notification_delivery(
  p_actor_id uuid,
  p_channel text,
  p_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_channel text := lower(trim(coalesce(p_channel, '')));
  v_status text;
  v_failure_kind text;
  v_attempt_count integer;
  v_next_retry_at timestamptz;
  v_before jsonb;
  v_after jsonb;
  v_target text := trim(coalesce(p_channel, '')) || ':' || p_id::text;
begin
  if not exists (select 1 from public.profiles where id = p_actor_id and is_admin) then raise exception 'ADMIN_REQUIRED'; end if;
  if v_channel not in ('line', 'telegram') then raise exception 'INVALID_NOTIFICATION_CHANNEL'; end if;

  if v_channel = 'line' then
    select status, failure_kind, attempt_count, next_retry_at
      into v_status, v_failure_kind, v_attempt_count, v_next_retry_at
      from public.line_notification_logs where id = p_id for update;
    if not found then raise exception 'NOTIFICATION_NOT_FOUND'; end if;
    if v_status <> 'failed' then raise exception 'NOTIFICATION_REQUEUE_NOT_ALLOWED'; end if;
    v_before := jsonb_build_object('channel', v_channel, 'status', v_status, 'failure_kind', v_failure_kind, 'attempt_count', v_attempt_count, 'next_retry_at', v_next_retry_at);
    update public.line_notification_logs set next_retry_at = current_timestamp, lease_expires_at = null, claimed_at = null, updated_at = current_timestamp where id = p_id returning next_retry_at into v_next_retry_at;
  else
    select status, failure_kind, attempt_count, next_retry_at
      into v_status, v_failure_kind, v_attempt_count, v_next_retry_at
      from public.telegram_notification_logs where id = p_id for update;
    if not found then raise exception 'NOTIFICATION_NOT_FOUND'; end if;
    if v_status <> 'failed' then raise exception 'NOTIFICATION_REQUEUE_NOT_ALLOWED'; end if;
    v_before := jsonb_build_object('channel', v_channel, 'status', v_status, 'failure_kind', v_failure_kind, 'attempt_count', v_attempt_count, 'next_retry_at', v_next_retry_at);
    update public.telegram_notification_logs set next_retry_at = current_timestamp, lease_expires_at = null, claimed_at = null, updated_at = current_timestamp where id = p_id returning next_retry_at into v_next_retry_at;
  end if;

  v_after := jsonb_build_object('channel', v_channel, 'status', 'failed', 'failure_kind', v_failure_kind, 'attempt_count', v_attempt_count, 'next_retry_at', v_next_retry_at);
  perform public.append_audit_log(p_actor_id, 'retry', 'notification_delivery', v_target, v_before, v_after);
  return jsonb_build_object('channel', v_channel, 'id', p_id, 'status', 'failed', 'failure_kind', v_failure_kind, 'attempt_count', v_attempt_count, 'next_retry_at', v_next_retry_at);
end;
$function$;

revoke all on function public.admin_list_notification_deliveries(uuid,text,text,integer,integer) from public, anon, authenticated;
revoke all on function public.admin_requeue_notification_delivery(uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.admin_list_notification_deliveries(uuid,text,text,integer,integer) to service_role;
grant execute on function public.admin_requeue_notification_delivery(uuid,text,uuid) to service_role;

comment on function public.admin_list_notification_deliveries(uuid,text,text,integer,integer) is
  '管理員通知送達紀錄查詢；只回傳遮罩收件人與狀態欄位，不回傳 payload、token 或完整 recipient_id';
comment on function public.admin_requeue_notification_delivery(uuid,text,uuid) is
  '只允許 failed 通知設定 next_retry_at，供下次 cron claim；不直接呼叫外部通知 API';

commit;
