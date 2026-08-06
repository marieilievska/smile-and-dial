-- Stop the Call Reviewer's pg_cron jobs.
--
-- The call-review + scoring feature (reviewer engine, /api/review/* routes,
-- reporting UI, and the calls.score column) was removed. These two jobs POST to
-- endpoints that no longer exist, so unschedule them. Guarded so re-applying —
-- or applying where a job was already gone — is a safe no-op.
--
-- This migration is code-first and drops NOTHING: the review_* tables and the
-- calls.score column are dropped in a SEPARATE follow-up migration only after
-- this removal has deployed (never drop a column/table before the code that
-- stopped using it is live).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'review-tick') then
    perform cron.unschedule('review-tick');
  end if;
  if exists (select 1 from cron.job where jobname = 'review-discover') then
    perform cron.unschedule('review-discover');
  end if;
end $$;
