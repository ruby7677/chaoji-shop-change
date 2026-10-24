-- pg_cron 會把每次排程的執行結果寫進 cron.job_run_details，且永遠不清：*/5 的過期訂單釋放、每小時與每日的工作
-- 每天新增約 300 列。保留最近 14 天（夠追查排程失敗）其餘每日清掉，避免佔用免費方案的 500MB 資料庫空間。
begin;

create or replace function public.purge_cron_run_details(p_keep_days integer default 14)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  -- 下限 3 天，避免誤傳參數一次清掉近期紀錄。
  v_keep_days integer := greatest(coalesce(p_keep_days, 14), 3);
  v_deleted integer;
begin
  -- 仍在執行中的紀錄 end_time 是 null，比較結果不成立，不會被刪。
  delete from cron.job_run_details
   where end_time < current_timestamp - make_interval(days => v_keep_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$function$;

revoke all on function public.purge_cron_run_details(integer) from public, anon, authenticated, service_role;
comment on function public.purge_cron_run_details(integer) is
  '刪除超過保留天數（預設 14、下限 3）的 cron.job_run_details 執行紀錄；由 pg_cron 每日執行';

select cron.unschedule(jobid) from cron.job where jobname = 'chaoji-purge-cron-run-details';
-- 每日 19:45 UTC（台灣 03:45），接在通知紀錄清理（03:30）之後。
select cron.schedule('chaoji-purge-cron-run-details', '45 19 * * *', 'select public.purge_cron_run_details();');

commit;
