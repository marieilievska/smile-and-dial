-- Daily refresh of the "best time to call" connect heatmap cache.
--
-- Smart-scheduled campaigns schedule their next retry at each day's BEST hour,
-- read from a cached 7x24 connect heatmap. Computing that heatmap scans up to
-- 90 days of calls, so we do it once a day in pg_cron (via pg_net) and stash it
-- in app_settings — the retry engine then only READS the cache on the hot path.
--
-- Mirrors the dialer-tick cron: same pg_net POST + the same dialer_tick_secret
-- read from app_settings as the x-dialer-secret header. The /api/best-time/
-- refresh endpoint gates on that exact secret, so until it's set out-of-band the
-- cron posts an empty secret and the endpoint rejects it (401) — a safe default.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotent (re)schedule: drop any existing job with this name first.
select cron.unschedule(jobid)
from cron.job
where jobname = 'best-time-refresh';

select cron.schedule(
  'best-time-refresh',
  '7 8 * * *',
  $cmd$
  select net.http_post(
    url := 'https://referrizer-smile-and-dial.vercel.app/api/best-time/refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dialer-secret', coalesce(
        (select dialer_tick_secret from public.app_settings limit 1), ''
      )
    ),
    body := '{}'::jsonb
  );
  $cmd$
);
