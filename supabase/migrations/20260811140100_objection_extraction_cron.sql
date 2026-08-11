-- Drain the Cause-of-Death objection queue every 2 minutes.
-- Mirrors smart-lists-refresh: pg_net POST with the dialer_tick_secret as the
-- x-dialer-secret header; the endpoint rejects an empty/wrong secret (401).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid)
from cron.job
where jobname = 'objection-extraction';

select cron.schedule(
  'objection-extraction',
  '*/2 * * * *',
  $cmd$
  select net.http_post(
    url := 'https://referrizer-smile-and-dial.vercel.app/api/reporting/objections',
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
