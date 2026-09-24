-- 修正 202609220002：PL/pgSQL EXECUTE 後不能依賴 FOUND 判斷動態 UPDATE 是否更新。
-- 使用 GET DIAGNOSTICS ROW_COUNT，保留 claim_token fencing 與既有函式簽名。

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
  v_table text;
  v_row record;
  v_claimed boolean := false;
  v_updated integer := 0;
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
  get diagnostics v_updated = row_count;

  if v_updated = 1 then
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

revoke all on function public.claim_notification_delivery(text,text,text,text,jsonb,integer)
  from public, anon, authenticated;
grant execute on function public.claim_notification_delivery(text,text,text,text,jsonb,integer) to service_role;

comment on function public.claim_notification_delivery(text,text,text,text,jsonb,integer) is
  '通知 event/recipient 原子 claim；以 GET DIAGNOSTICS ROW_COUNT 判定動態 UPDATE 是否實際 claim，並以 claim_token fencing 舊 attempt';

commit;
