-- Point every HTTP cron at the canonical host, with a real timeout.
--
-- Five pg_cron jobs drive the app from inside Postgres by POSTing an API route
-- via pg_net: dialer-tick (every minute), smart-lists-refresh (every 3 min),
-- objection-extraction (every 2 min), meta-audience-sync (daily) and
-- best-time-refresh (daily). All five were scheduled against the throwaway
-- deploy alias `referrizer-smile-and-dial.vercel.app`. The app's canonical
-- public domain is `https://www.smile-and-dial.com` (src/lib/app-url.ts); the
-- alias only keeps working while Vercel happens to keep it attached, so the
-- crons should call the same host everything else does.
--
-- Timeout: pg_net's `net.http_post` defaults `timeout_milliseconds` to 5000.
-- The dialer tick can legitimately run far longer than 5 s — it sleeps inside
-- the request to pace dials (up to MAX_TICK_SLEEP_MS = 45 s in
-- src/lib/dialer/tick.ts) — so pg_net logged spurious "Timeout of 5000 ms" rows
-- in net._http_response for ticks that actually completed fine. An explicit
-- 30 s timeout keeps most tick responses visible (status + body) for
-- debugging, while still bounding how long a single request can occupy
-- pg_net's background worker. The tick is idempotent and re-fires every
-- minute, so a rare >30 s tick that gets cut off loses nothing.
--
-- Same job names, same schedules, same secret lookups from app_settings —
-- only the host and the timeout change. Idempotent: each job is unscheduled
-- by name only if it exists, then rescheduled.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- dialer-tick: every minute -> /api/dialer/tick -----------------------------
select cron.unschedule(jobid)
from cron.job
where jobname = 'dialer-tick';

select cron.schedule(
  'dialer-tick',
  '* * * * *',
  $cmd$
  select net.http_post(
    url := 'https://www.smile-and-dial.com/api/dialer/tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dialer-secret', coalesce(
        (select dialer_tick_secret from public.app_settings limit 1), ''
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cmd$
);

-- meta-audience-sync: daily 08:00 UTC -> /api/meta/sync ----------------------
select cron.unschedule(jobid)
from cron.job
where jobname = 'meta-audience-sync';

select cron.schedule(
  'meta-audience-sync',
  '0 8 * * *',
  $cmd$
  select net.http_post(
    url := 'https://www.smile-and-dial.com/api/meta/sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-meta-sync-secret', coalesce(
        (select meta_sync_secret from public.app_settings limit 1), ''
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cmd$
);

-- best-time-refresh: daily 08:07 UTC -> /api/best-time/refresh --------------
select cron.unschedule(jobid)
from cron.job
where jobname = 'best-time-refresh';

select cron.schedule(
  'best-time-refresh',
  '7 8 * * *',
  $cmd$
  select net.http_post(
    url := 'https://www.smile-and-dial.com/api/best-time/refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dialer-secret', coalesce(
        (select dialer_tick_secret from public.app_settings limit 1), ''
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cmd$
);

-- smart-lists-refresh: every 3 minutes -> /api/smart-lists/refresh ----------
select cron.unschedule(jobid)
from cron.job
where jobname = 'smart-lists-refresh';

select cron.schedule(
  'smart-lists-refresh',
  '*/3 * * * *',
  $cmd$
  select net.http_post(
    url := 'https://www.smile-and-dial.com/api/smart-lists/refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dialer-secret', coalesce(
        (select dialer_tick_secret from public.app_settings limit 1), ''
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cmd$
);

-- objection-extraction: every 2 minutes -> /api/reporting/objections --------
select cron.unschedule(jobid)
from cron.job
where jobname = 'objection-extraction';

select cron.schedule(
  'objection-extraction',
  '*/2 * * * *',
  $cmd$
  select net.http_post(
    url := 'https://www.smile-and-dial.com/api/reporting/objections',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dialer-secret', coalesce(
        (select dialer_tick_secret from public.app_settings limit 1), ''
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cmd$
);
