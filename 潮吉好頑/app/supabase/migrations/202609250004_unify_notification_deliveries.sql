-- 潮吉好頑：LINE 與 Telegram 通知紀錄合併為單一 notification_deliveries 表。
-- 原本兩張欄位完全相同的 log table 讓所有通知函式以 execute format('%I') 動態切換表名，
-- 建立函式時無法檢查欄位、改結構要兩張表同步。改為單表＋channel 欄位、函式全部改為靜態 SQL。
-- 5 支 RPC 的名稱、參數與回傳格式不變，Worker 不需改動；既有紀錄保留原 id 與 claim_token，
-- 進行中的 claim 在切換後仍可 complete。
--
-- 另外：
-- * pending 只會在 claim 函式同一個交易內短暫存在（先 insert 再 claim）；已提交的 pending 都是
--   狀態機上線前的舊紀錄，retry cron 永遠不會處理，改為 failed（permanent、不自動重試），
--   需要時由後台「重新排入」，不會自動補發過期通知。
-- * 重複 claim 已送出（sent）的通知不再寫入資料列（原本每次都更新 updated_at）。
-- * 新增 purge_notification_deliveries 與每日 pg_cron：刪除 180 天前已送出、或已失敗且不再重試的紀錄。
--   event key 皆含訂單 id＋時間、日期或當日建立的生日券 id，舊事件不會再次觸發，刪除不會造成重送。

begin;

-- 複製期間阻擋舊表寫入，避免資料遺失；進行中的通知呼叫會等待本交易完成。
lock table public.line_notification_logs, public.telegram_notification_logs in exclusive mode;

create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  channel text not null,
  event_key text not null,
  recipient_id text not null,
  event_type text not null,
  status text not null default 'pending',
  error_message text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  attempt_count integer not null default 0,
  claimed_at timestamptz,
  claim_token uuid,
  lease_expires_at timestamptz,
  next_retry_at timestamptz,
  last_attempt_at timestamptz,
  last_status_code integer,
  failure_kind text,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint notification_deliveries_channel_check check (channel in ('line', 'telegram')),
  constraint notification_deliveries_status_check check (status in ('pending', 'processing', 'sent', 'failed')),
  constraint notification_deliveries_attempt_count_check check (attempt_count >= 0),
  constraint notification_deliveries_failure_kind_check check (failure_kind is null or failure_kind in ('transient', 'permanent')),
  constraint notification_deliveries_channel_event_recipient_key unique (channel, event_key, recipient_id)
);

comment on table public.notification_deliveries is
  'LINE／Telegram 通知送達狀態機（claim、lease、claim_token fencing、重試）；僅 service_role 與 SECURITY DEFINER 函式存取';

create index notification_deliveries_retry_due_idx
  on public.notification_deliveries (channel, next_retry_at)
  where status = 'failed' and next_retry_at is not null;
create index notification_deliveries_lease_due_idx
  on public.notification_deliveries (channel, lease_expires_at)
  where status = 'processing';
create index notification_deliveries_updated_idx
  on public.notification_deliveries (updated_at desc, id desc);

alter table public.notification_deliveries enable row level security;
create policy "deny api roles" on public.notification_deliveries
  for all to anon, authenticated using (false) with check (false);
revoke all on table public.notification_deliveries from public, anon, authenticated;
grant all on table public.notification_deliveries to service_role;

insert into public.notification_deliveries (
  id, channel, event_key, recipient_id, event_type, status, error_message, sent_at, created_at,
  attempt_count, claimed_at, claim_token, lease_expires_at, next_retry_at, last_attempt_at,
  last_status_code, failure_kind, payload, updated_at
)
select id, 'line', event_key, recipient_id, event_type, status, error_message, sent_at, created_at,
       attempt_count, claimed_at, claim_token, lease_expires_at, next_retry_at, last_attempt_at,
       last_status_code, failure_kind, payload, updated_at
  from public.line_notification_logs
union all
select id, 'telegram', event_key, recipient_id, event_type, status, error_message, sent_at, created_at,
       attempt_count, claimed_at, claim_token, lease_expires_at, next_retry_at, last_attempt_at,
       last_status_code, failure_kind, payload, updated_at
  from public.telegram_notification_logs;

update public.notification_deliveries
   set status = 'failed',
       failure_kind = 'permanent',
       next_retry_at = null,
       error_message = '通知狀態機上線前的舊紀錄，未送出；需要時可由後台重新排入',
       updated_at = current_timestamp
 where status = 'pending';

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
         error_message = null,
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
           error_message = null,
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
         error_message = case when v_sent then null else left(coalesce(p_error_message, '通知發送失敗'), 500) end,
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

  select coalesce(jsonb_agg(to_jsonb(s) order by s.updated_at desc, s.id desc), '[]'::jsonb)
    into v_items
    from (
      select d.id, d.channel, d.event_key, d.event_type,
        case when d.channel = 'line' then coalesce(p.full_name, 'LINE 會員') else '管理員 Telegram' end as recipient_name,
        o.order_number,
        case when length(d.recipient_id) <= 4 then repeat('*', length(d.recipient_id))
             else left(d.recipient_id, 2) || repeat('*', least(12, length(d.recipient_id) - 4)) || right(d.recipient_id, 2) end as recipient_hint,
        d.status, d.attempt_count, d.last_status_code, d.error_message, d.failure_kind,
        d.next_retry_at, d.last_attempt_at, d.created_at, d.updated_at
        from public.notification_deliveries d
        left join public.profiles p on d.channel = 'line' and p.line_user_id = d.recipient_id
        -- 只對已知訂單事件前綴＋canonical UUID 回查訂單；生日券、低庫存、測試事件不猜訂單。
        left join public.orders o on o.id = case
          when d.event_key ~ '^(created|payment_reported|status_changed|fulfillment_updated):[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(:|$)'
            then substring(d.event_key from '^[^:]+:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})')::uuid
          else null
        end
       where (v_channel = 'all' or d.channel = v_channel)
         and (v_status = 'all' or d.status = v_status)
       order by d.updated_at desc, d.id desc
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

  select status, failure_kind, attempt_count, next_retry_at
    into v_status, v_failure_kind, v_attempt_count, v_next_retry_at
    from public.notification_deliveries
   where id = p_id and channel = v_channel
     for update;
  if not found then raise exception 'NOTIFICATION_NOT_FOUND'; end if;
  if v_status <> 'failed' then raise exception 'NOTIFICATION_REQUEUE_NOT_ALLOWED'; end if;

  v_before := jsonb_build_object('channel', v_channel, 'status', v_status, 'failure_kind', v_failure_kind, 'attempt_count', v_attempt_count, 'next_retry_at', v_next_retry_at);
  update public.notification_deliveries
     set next_retry_at = current_timestamp, lease_expires_at = null, claimed_at = null, updated_at = current_timestamp
   where id = p_id
  returning next_retry_at into v_next_retry_at;

  v_after := jsonb_build_object('channel', v_channel, 'status', 'failed', 'failure_kind', v_failure_kind, 'attempt_count', v_attempt_count, 'next_retry_at', v_next_retry_at);
  perform public.append_audit_log(p_actor_id, 'retry', 'notification_delivery', v_target, v_before, v_after);
  return jsonb_build_object('channel', v_channel, 'id', p_id, 'status', 'failed', 'failure_kind', v_failure_kind, 'attempt_count', v_attempt_count, 'next_retry_at', v_next_retry_at);
end;
$function$;

create or replace function public.purge_notification_deliveries(p_keep_days integer default 180)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  -- 下限 30 天，避免誤傳參數一次清掉近期紀錄。
  v_keep_days integer := greatest(coalesce(p_keep_days, 180), 30);
  v_deleted integer;
begin
  delete from public.notification_deliveries
   where updated_at < current_timestamp - make_interval(days => v_keep_days)
     and (status = 'sent' or (status = 'failed' and next_retry_at is null));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$function$;

drop table public.line_notification_logs;
drop table public.telegram_notification_logs;

revoke all on function public.claim_notification_delivery(text,text,text,text,jsonb,integer) from public, anon, authenticated;
revoke all on function public.claim_due_notification_deliveries(text,integer,integer) from public, anon, authenticated;
revoke all on function public.complete_notification_delivery(text,uuid,uuid,boolean,integer,text,boolean,integer) from public, anon, authenticated;
revoke all on function public.admin_list_notification_deliveries(uuid,text,text,integer,integer) from public, anon, authenticated;
revoke all on function public.admin_requeue_notification_delivery(uuid,text,uuid) from public, anon, authenticated;
revoke all on function public.purge_notification_deliveries(integer) from public, anon, authenticated, service_role;
grant execute on function public.claim_notification_delivery(text,text,text,text,jsonb,integer) to service_role;
grant execute on function public.claim_due_notification_deliveries(text,integer,integer) to service_role;
grant execute on function public.complete_notification_delivery(text,uuid,uuid,boolean,integer,text,boolean,integer) to service_role;
grant execute on function public.admin_list_notification_deliveries(uuid,text,text,integer,integer) to service_role;
grant execute on function public.admin_requeue_notification_delivery(uuid,text,uuid) to service_role;

comment on function public.claim_notification_delivery(text,text,text,text,jsonb,integer) is
  '通知 channel/event/recipient 原子 claim；sent 不重送也不再寫入、processing 需 lease 過期、failed 需 next_retry_at 到期才可重試';
comment on function public.claim_due_notification_deliveries(text,integer,integer) is
  '以 SKIP LOCKED 原子領取指定 channel 到期 retry 或 lease 過期通知';
comment on function public.complete_notification_delivery(text,uuid,uuid,boolean,integer,text,boolean,integer) is
  '以 claim_token fencing 完成通知；retryable 失敗排入 next_retry_at，其餘失敗為 permanent';
comment on function public.admin_list_notification_deliveries(uuid,text,text,integer,integer) is
  '通知列表補充遮罩收件人 hint、LINE 會員姓名與已知訂單事件的訂單編號；非訂單 event_key 保留 null';
comment on function public.admin_requeue_notification_delivery(uuid,text,uuid) is
  '只允許 failed 通知設定 next_retry_at，供下次 cron claim；不直接呼叫外部通知 API';
comment on function public.purge_notification_deliveries(integer) is
  '刪除超過保留天數（預設 180、下限 30）的 sent 與不再重試的 failed 通知紀錄；由 pg_cron 每日執行';

select cron.unschedule(jobid) from cron.job where jobname = 'chaoji-purge-notification-deliveries';
-- 每日 19:30 UTC（台灣 03:30）。
select cron.schedule('chaoji-purge-notification-deliveries', '30 19 * * *', 'select public.purge_notification_deliveries();');

commit;
