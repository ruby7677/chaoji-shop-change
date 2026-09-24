-- 通知送達狀態機：原子 claim、lease、重試時間與永久/暫時錯誤分類。
-- LINE 與 Telegram 維持獨立 log table；憑證不寫入資料庫。

begin;

alter table public.line_notification_logs
  drop constraint if exists line_notification_logs_status_check,
  drop constraint if exists line_notification_logs_attempt_count_check,
  drop constraint if exists line_notification_logs_failure_kind_check;
alter table public.telegram_notification_logs
  drop constraint if exists telegram_notification_logs_status_check,
  drop constraint if exists telegram_notification_logs_attempt_count_check,
  drop constraint if exists telegram_notification_logs_failure_kind_check;

alter table public.line_notification_logs
  add column if not exists attempt_count integer not null default 0,
  add column if not exists claimed_at timestamptz,
  add column if not exists claim_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists next_retry_at timestamptz,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists last_status_code integer,
  add column if not exists failure_kind text,
  add column if not exists payload jsonb not null default '{}'::jsonb,
  add column if not exists updated_at timestamptz not null default now();

alter table public.telegram_notification_logs
  add column if not exists attempt_count integer not null default 0,
  add column if not exists claimed_at timestamptz,
  add column if not exists claim_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists next_retry_at timestamptz,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists last_status_code integer,
  add column if not exists failure_kind text,
  add column if not exists payload jsonb not null default '{}'::jsonb,
  add column if not exists updated_at timestamptz not null default now();

alter table public.line_notification_logs
  add constraint line_notification_logs_status_check
    check (status in ('pending', 'processing', 'sent', 'failed')),
  add constraint line_notification_logs_attempt_count_check
    check (attempt_count >= 0),
  add constraint line_notification_logs_failure_kind_check
    check (failure_kind is null or failure_kind in ('transient', 'permanent'));

alter table public.telegram_notification_logs
  add constraint telegram_notification_logs_status_check
    check (status in ('pending', 'processing', 'sent', 'failed')),
  add constraint telegram_notification_logs_attempt_count_check
    check (attempt_count >= 0),
  add constraint telegram_notification_logs_failure_kind_check
    check (failure_kind is null or failure_kind in ('transient', 'permanent'));

create index if not exists line_notification_logs_retry_due_idx
  on public.line_notification_logs (next_retry_at)
  where status = 'failed' and next_retry_at is not null;
create index if not exists line_notification_logs_lease_due_idx
  on public.line_notification_logs (lease_expires_at)
  where status = 'processing';
create index if not exists telegram_notification_logs_retry_due_idx
  on public.telegram_notification_logs (next_retry_at)
  where status = 'failed' and next_retry_at is not null;
create index if not exists telegram_notification_logs_lease_due_idx
  on public.telegram_notification_logs (lease_expires_at)
  where status = 'processing';

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
  v_table text;
  v_row record;
  v_claimed boolean := false;
  v_lease integer := greatest(30, least(coalesce(p_lease_seconds, 120), 900));
begin
  if p_channel = 'line' then
    v_table := 'line_notification_logs';
  elsif p_channel = 'telegram' then
    v_table := 'telegram_notification_logs';
  else
    raise exception 'INVALID_NOTIFICATION_CHANNEL';
  end if;
  if nullif(trim(p_event_key), '') is null or nullif(trim(p_recipient_id), '') is null
     or nullif(trim(p_event_type), '') is null then
    raise exception 'INVALID_NOTIFICATION_CLAIM';
  end if;

  execute format(
    'insert into public.%I(event_key, recipient_id, event_type, payload)
     values ($1, $2, $3, coalesce($4, ''{}''::jsonb))
     on conflict (event_key, recipient_id) do update
       set event_type = excluded.event_type,
           payload = case when %I.status = ''sent'' then %I.payload else excluded.payload end,
           updated_at = current_timestamp',
    v_table, v_table, v_table
  ) using p_event_key, p_recipient_id, p_event_type, p_payload;

  execute format(
    'update public.%I
        set status = ''processing'',
            attempt_count = attempt_count + 1,
            claimed_at = current_timestamp,
            claim_token = gen_random_uuid(),
            last_attempt_at = current_timestamp,
            lease_expires_at = current_timestamp + make_interval(secs => $3),
            next_retry_at = null,
            failure_kind = null,
            error_message = null,
            updated_at = current_timestamp
      where event_key = $1
        and recipient_id = $2
        and (
          status = ''pending''
          or (status = ''failed'' and next_retry_at is not null and next_retry_at <= current_timestamp)
          or (status = ''processing'' and lease_expires_at is not null and lease_expires_at <= current_timestamp)
        )
      returning id, claim_token, status, attempt_count, payload',
    v_table
  ) into v_row using p_event_key, p_recipient_id, v_lease;

  if found then
    v_claimed := true;
  else
    execute format(
      'select id, claim_token, status, attempt_count, payload
         from public.%I
        where event_key = $1 and recipient_id = $2',
      v_table
    ) into v_row using p_event_key, p_recipient_id;
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
  v_table text;
  v_limit integer := greatest(1, least(coalesce(p_limit, 25), 100));
  v_lease integer := greatest(30, least(coalesce(p_lease_seconds, 120), 900));
  v_row record;
begin
  if p_channel = 'line' then
    v_table := 'line_notification_logs';
  elsif p_channel = 'telegram' then
    v_table := 'telegram_notification_logs';
  else
    raise exception 'INVALID_NOTIFICATION_CHANNEL';
  end if;

  for v_row in execute format(
    'with due as (
       select id
         from public.%I
        where (status = ''failed'' and next_retry_at is not null and next_retry_at <= current_timestamp)
           or (status = ''processing'' and lease_expires_at is not null and lease_expires_at <= current_timestamp)
        order by coalesce(next_retry_at, lease_expires_at), created_at
        for update skip locked
        limit $1
     )
     update public.%I n
        set status = ''processing'',
            attempt_count = n.attempt_count + 1,
            claimed_at = current_timestamp,
            claim_token = gen_random_uuid(),
            last_attempt_at = current_timestamp,
            lease_expires_at = current_timestamp + make_interval(secs => $2),
            next_retry_at = null,
            failure_kind = null,
            error_message = null,
            updated_at = current_timestamp
       from due
      where n.id = due.id
      returning n.id, n.claim_token, n.event_key, n.recipient_id, n.event_type, n.status,
                n.attempt_count, n.payload',
    v_table, v_table
  ) using v_limit, v_lease
  loop
    return next to_jsonb(v_row);
  end loop;
  return;
end;
$function$;

drop function if exists public.complete_notification_delivery(text, uuid, boolean, integer, text, boolean, integer);

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
  v_table text;
  v_retry_seconds integer;
  v_updated integer;
begin
  if p_channel = 'line' then
    v_table := 'line_notification_logs';
  elsif p_channel = 'telegram' then
    v_table := 'telegram_notification_logs';
  else
    raise exception 'INVALID_NOTIFICATION_CHANNEL';
  end if;

  v_retry_seconds := greatest(1, least(coalesce(p_retry_after_seconds, 30), 86400));
  execute format(
    'update public.%I
        set status = case when $2 then ''sent'' else ''failed'' end,
            sent_at = case when $2 then current_timestamp else sent_at end,
            error_message = case when $2 then null else left(coalesce($4, ''通知發送失敗''), 500) end,
            last_status_code = $3,
            failure_kind = case when $2 then null when $5 then ''transient'' else ''permanent'' end,
             next_retry_at = case when not $2 and $5 then current_timestamp + make_interval(secs => $6) else null end,
            lease_expires_at = null,
            updated_at = current_timestamp
      where id = $1 and status = ''processing'' and claim_token = $7',
    v_table
  ) using p_id, coalesce(p_sent, false), p_status_code, p_error_message, coalesce(p_retryable, false), v_retry_seconds, p_claim_token;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$function$;

revoke all on function public.claim_notification_delivery(text,text,text,text,jsonb,integer)
  from public, anon, authenticated;
revoke all on function public.claim_due_notification_deliveries(text,integer,integer)
  from public, anon, authenticated;
revoke all on function public.complete_notification_delivery(text,uuid,uuid,boolean,integer,text,boolean,integer)
  from public, anon, authenticated;
grant execute on function public.claim_notification_delivery(text,text,text,text,jsonb,integer) to service_role;
grant execute on function public.claim_due_notification_deliveries(text,integer,integer) to service_role;
grant execute on function public.complete_notification_delivery(text,uuid,uuid,boolean,integer,text,boolean,integer) to service_role;

comment on function public.claim_notification_delivery(text,text,text,text,jsonb,integer) is
  '通知 event/recipient 原子 claim；sent 不重送、processing 需 lease 過期、failed 需 next_retry_at 到期才可重試';
comment on function public.claim_due_notification_deliveries(text,integer,integer) is
  '以 SKIP LOCKED 原子領取到期 retry 或 lease 過期通知';

commit;
