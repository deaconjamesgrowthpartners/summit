-- Summit  migration 016  nightly sync moves to source-sync
-- Run in the Supabase SQL editor of project tyrtzxnhwjchtemytfxv ONLY AFTER the source-sync edge function is
-- deployed and one run of it has come back ok:
--   select source_sync_now((select id from deal_sources where connector = 'aspire'), 'manual');
--   select status, rows_pulled, errors from source_runs order by id desc limit 1;
-- Safe to run more than once. Until this runs, the old aspire-sync function and its nightly job keep working
-- through 012's compatibility wrappers, so nothing breaks in between.

begin;
select source_schedule_apply();
select cron.unschedule('aspire-sync-nightly') where exists (select 1 from cron.job where jobname = 'aspire-sync-nightly');
commit;

select jobname, schedule, command from cron.job where jobname like 'source-sync-%' or jobname = 'aspire-sync-nightly';
