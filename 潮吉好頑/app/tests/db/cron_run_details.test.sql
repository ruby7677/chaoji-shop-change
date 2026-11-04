-- cron.job_run_details 清理（202610190001）：只刪超過保留天數且已結束的紀錄；天數下限 3；只給排程（擁有者）執行。
begin;
select tests.seed();
select tests.login(tests.id('member_a'));
select tests.expect_error($$select public.purge_cron_run_details(14)$$, 'permission denied', 'members cannot purge cron history');
select tests.login(null);
select tests.expect_error($$select public.purge_cron_run_details(14)$$, 'permission denied', 'anon cannot purge cron history');
select tests.as_service();
select tests.expect_error($$select public.purge_cron_run_details(14)$$, 'permission denied', 'the Worker cannot purge cron history');
rollback;

begin;
select tests.seed();
delete from cron.job_run_details;
insert into cron.job_run_details(jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time) values
  (1, 9001, 1, 'cj_test', 'postgres', 'select 1', 'succeeded', 'ok', now() - interval '40 days', now() - interval '40 days'),
  (1, 9002, 1, 'cj_test', 'postgres', 'select 1', 'failed',    'bad', now() - interval '20 days', now() - interval '20 days'),
  (1, 9003, 1, 'cj_test', 'postgres', 'select 1', 'succeeded', 'ok', now() - interval '10 days', now() - interval '10 days'),
  (1, 9004, 1, 'cj_test', 'postgres', 'select 1', 'running',   null, now() - interval '30 days', null),
  (1, 9005, 1, 'cj_test', 'postgres', 'select 1', 'succeeded', 'ok', now() - interval '1 hour', now() - interval '1 hour');
select tests.assert(public.purge_cron_run_details() = 2, 'the default deletes finished runs older than 14 days');
select tests.assert((select array_agg(runid order by runid) = array[9003, 9004, 9005]::bigint[] from cron.job_run_details),
                    'recent runs and runs still in progress are kept');
select tests.assert(public.purge_cron_run_details() = 0, 'a second run has nothing left to delete');
select tests.assert(public.purge_cron_run_details(0) = 1, 'the keep days have a 3-day floor: 10-day-old runs go, 1-hour-old runs stay');
select tests.assert((select array_agg(runid order by runid) = array[9004, 9005]::bigint[] from cron.job_run_details), 'only the in-progress and newest runs remain');
select tests.assert((select count(*) = 1 from cron.job where jobname = 'chaoji-purge-cron-run-details' and command = 'select public.purge_cron_run_details();'), 'the purge runs daily via pg_cron');
rollback;
