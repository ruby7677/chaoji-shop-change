-- 通知重送後保留前次失敗原因：原本每次 claim 都清空 error_message，重送成功後無法判斷是
-- 供應商回錯、網路逾時，還是 Worker 送出後沒回報結果（lease 過期被排程重送，可能造成重複通知）。
-- claim：failed 的錯誤訊息保留；lease 過期回收時記下「未回報結果」。
-- complete：失敗寫入本次原因；成功時若有前次原因，改寫成「已重送成功；前次：…」，第一次就成功則為 null。
begin;

create or replace function public.claim_notification_delivery(
  p_channel text,
  p_event_key text,
  p_recipient_id text,
  p_event_type text,
  p_payload jsonb,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_row record;
  v_claimed boolean := false;
  v_updated integer := 0;
  v_lease integer := greatest(30, least(coalesce(p_lease_seconds, 120), 900));
begin
  if p_channel is null or p_channel not in ('line', 'telegram') then
    raise exception 'INVALID_NOTIFICATION_CHANNEL';
  end if;
  if nullif(trim(p_event_key), '') is null or nullif(trim(p_recipient_id), '') is null
     or nullif(trim(p_event_type), '') is null then
    raise exception 'INVALID_NOTIFICATION_CLAIM';
  end if;

  insert into public.notification_deliveries as d (channel, event_key, recipient_id, event_type, payload)
  values (p_channel, p_event_key, p_recipient_id, p_event_type, coalesce(p_payload, '{}'::jsonb))
  on conflict (channel, event_key, recipient_id) do update
     set event_type = excluded.event_type,
         payload = excluded.payload,
         updated_at = current_timestamp
   where d.status <> 'sent';

  update public.notification_deliveries
     set status = 'processing',
         attempt_count = attempt_count + 1,
         claimed_at = current_timestamp,
         claim_token = gen_random_uuid(),
         last_attempt_at = current_timestamp,
         lease_expires_at = current_timestamp + make_interval(secs => v_lease),
         next_retry_at = null,
         failure_kind = null,
         error_message = case
           when status = 'processing' then '前次發送後未回報結果（逾時或處理中斷），訊息可能已送達'
           else error_message
         end,
         updated_at = current_timestamp
   where channel = p_channel
     and event_key = p_event_key
     and recipient_id = p_recipient_id
     and (
       status = 'pending'
       or (status = 'failed' and next_retry_at is not null and next_retry_at <= current_timestamp)
       or (status = 'processing' and lease_expires_at is not null and lease_expires_at <= current_timestamp)
     )
  returning id, claim_token, status, attempt_count, payload into v_row;
  get diagnostics v_updated = row_count;

  if v_updated = 1 then
    v_claimed := true;
  else
    select id, claim_token, status, attempt_count, payload
      into v_row
      from public.notification_deliveries
     where channel = p_channel and event_key = p_event_key and recipient_id = p_recipient_id;
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'claim_token', v_row.claim_token,
    'status', v_row.status,
    'attempt_count', coalesce(v_row.attempt_count, 0),
    'payload', coalesce(v_row.payload, '{}'::jsonb),
    'claimed', v_claimed
  );
end;
$function$;

create or replace function public.claim_due_notification_deliveries(
  p_channel text,
  p_limit integer default 25,
  p_lease_seconds integer default 120
)
returns setof jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 25), 100));
  v_lease integer := greatest(30, least(coalesce(p_lease_seconds, 120), 900));
begin
  if p_channel is null or p_channel not in ('line', 'telegram') then
    raise exception 'INVALID_NOTIFICATION_CHANNEL';
  end if;

  return query
  with due as (
    select d.id
      from public.notification_deliveries d
     where d.channel = p_channel
       and (
         (d.status = 'failed' and d.next_retry_at is not null and d.next_retry_at <= current_timestamp)
         or (d.status = 'processing' and d.lease_expires_at is not null and d.lease_expires_at <= current_timestamp)
       )
     order by coalesce(d.next_retry_at, d.lease_expires_at), d.created_at
     for update skip locked
     limit v_limit
  ), claimed as (
    update public.notification_deliveries n
       set status = 'processing',
           attempt_count = n.attempt_count + 1,
           claimed_at = current_timestamp,
           claim_token = gen_random_uuid(),
           last_attempt_at = current_timestamp,
           lease_expires_at = current_timestamp + make_interval(secs => v_lease),
           next_retry_at = null,
           failure_kind = null,
           error_message = case
             when n.status = 'processing' then '前次發送後未回報結果（逾時或處理中斷），訊息可能已送達'
             else n.error_message
           end,
           updated_at = current_timestamp
      from due
     where n.id = due.id
    returning n.id, n.claim_token, n.event_key, n.recipient_id, n.event_type, n.status, n.attempt_count, n.payload
  )
  select to_jsonb(c) from claimed c;
end;
$function$;

create or replace function public.complete_notification_delivery(
  p_channel text,
  p_id uuid,
  p_claim_token uuid,
  p_sent boolean,
  p_status_code integer default null,
  p_error_message text default null,
  p_retryable boolean default false,
  p_retry_after_seconds integer default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_sent boolean := coalesce(p_sent, false);
  v_retryable boolean := coalesce(p_retryable, false);
  v_retry_seconds integer := greatest(1, least(coalesce(p_retry_after_seconds, 30), 86400));
  v_updated integer;
begin
  if p_channel is null or p_channel not in ('line', 'telegram') then
    raise exception 'INVALID_NOTIFICATION_CHANNEL';
  end if;

  update public.notification_deliveries
     set status = case when v_sent then 'sent' else 'failed' end,
         sent_at = case when v_sent then current_timestamp else sent_at end,
         error_message = case
           when not v_sent then left(coalesce(p_error_message, '通知發送失敗'), 500)
           when error_message is null then null
           else left('已重送成功；前次：' || error_message, 500)
         end,
         last_status_code = p_status_code,
         failure_kind = case when v_sent then null when v_retryable then 'transient' else 'permanent' end,
         next_retry_at = case when not v_sent and v_retryable then current_timestamp + make_interval(secs => v_retry_seconds) else null end,
         lease_expires_at = null,
         updated_at = current_timestamp
   where id = p_id and channel = p_channel and status = 'processing' and claim_token = p_claim_token;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$function$;

comment on function public.complete_notification_delivery(text,uuid,uuid,boolean,integer,text,boolean,integer) is
  '以 claim_token fencing 完成通知；retryable 失敗排入 next_retry_at，其餘失敗為 permanent；重送成功時保留前次原因';

commit;
