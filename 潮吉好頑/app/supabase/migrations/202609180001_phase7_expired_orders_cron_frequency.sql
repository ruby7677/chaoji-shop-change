-- Phase 7: reduce expired-order cleanup frequency while preserving the job contract.
-- The explicit unschedule makes this safe to re-run: at most one job with this
-- name remains, and the command is unchanged.
begin;

create extension if not exists pg_cron with schema pg_catalog;

select cron.unschedule(jobid)
from cron.job
where jobname = 'chaoji-release-expired-orders';

select cron.schedule(
  'chaoji-release-expired-orders',
  '*/5 * * * *',
  'select public.cancel_expired_orders();'
);

commit;
