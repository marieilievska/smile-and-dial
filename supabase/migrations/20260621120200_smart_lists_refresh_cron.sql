-- Refresh smart-list membership every few minutes.
--
-- A smart list (saved filter) auto-includes any new lead matching the filter.
-- This cron rebuilds the smart_list_members cache for every attached smart list
-- so freshly imported leads become callable within minutes. Mirrors the
-- best-time-refresh cron: pg_net POST with the dialer_tick_secret as the
-- x-dialer-secret header; the endpoint rejects an empty/wrong secret (401).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotent (re)schedule: drop any existing job with this name first.
select cron.unschedule(jobid)
from cron.job
where jobname = 'smart-lists-refresh';

select cron.schedule(
  'smart-lists-refresh',
  '*/3 * * * *',
  $cmd$
  select net.http_post(
    url := 'https://referrizer-smile-and-dial.vercel.app/api/smart-lists/refresh',
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
