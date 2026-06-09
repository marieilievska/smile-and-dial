-- Wire the autopilot dialer's recurring trigger.
--
-- The dialer is an HTTP endpoint (/api/dialer/tick): each hit pulls the next
-- batch from the dial_queue and places those calls. Nothing was ever scheduled
-- to hit it, so "autopilot" campaigns sat with a full queue and never dialed.
-- Schedule pg_cron to POST that endpoint once a minute (via pg_net),
-- authenticated with the dialer secret.
--
-- This does NOT bypass any safety: pre_call_check still enforces calling hours,
-- per-campaign hourly/daily call caps, concurrency, spend caps, and DNC on every
-- dial — so this paces the list, it doesn't blast it.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- The tick secret lives in the app_settings singleton (DB-as-truth, like the
-- other webhook secrets). Set out-of-band so it never lands in git. Until it's
-- set, the cron posts an empty secret and the endpoint rejects it (401) — a
-- safe default that keeps the dialer off until we explicitly arm it.
alter table public.app_settings
  add column if not exists dialer_tick_secret text;

-- Idempotent (re)schedule: drop any existing job with this name first.
select cron.unschedule(jobid)
from cron.job
where jobname = 'dialer-tick';

select cron.schedule(
  'dialer-tick',
  '* * * * *',
  $cmd$
  select net.http_post(
    url := 'https://referrizer-smile-and-dial.vercel.app/api/dialer/tick',
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
