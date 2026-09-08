-- SHAKEN/STIR reconcile, every 30 minutes, on a schedule the alerts can see.
--
-- Signing a number for A-attestation happens at purchase and is best-effort by
-- design: a Trust Hub hiccup must never cost us a number we just paid for. That
-- makes a backstop load-bearing. On 2026-09-02, 97 numbers were bought and the
-- trust-product POST failed transiently for ten of them (clustered at 09:26,
-- 09:42 and 09:51 — the other 87 succeeded the same morning with identical
-- code, so this was rate-limiting, not misconfiguration). Those ten sat on the
-- supporting customer profile and NOT on the SHAKEN trust product, and dialled
-- for six days with no A-attestation.
--
-- The backstop that existed for exactly this — scripts/sync-shaken-numbers.mjs,
-- every 30 minutes under Windows Task Scheduler on one machine — was not
-- running: no matching scheduled task, no .shaken-sync.log, no launcher. The
-- script was then deleted on 2026-09-05 by #459 as a "dead script", which is
-- precisely how it looked, because a Task Scheduler entry is not an import
-- anyone can grep for.
--
-- So the reconcile moved into the app (/api/shaken/reconcile, from
-- lib/twilio/shaken.ts) and its schedule moves here. Not because pg_cron is
-- tidier, but because it is WATCHED: evaluate_alerts() runs every five minutes
-- and raises `cron_missed` for any pg_cron job whose last run is older than 3x
-- its own schedule, or whose last run failed. If this job stops, an admin is
-- told. Nothing could ever have told them a scheduled task on a laptop had
-- stopped, and nothing did.
--
-- Same pattern as every other HTTP cron here: pg_net POST to the canonical host
-- (https://www.smile-and-dial.com — the throwaway Vercel alias only works while
-- Vercel keeps it attached; see 20260905171000_crons_canonical_host.sql), the
-- x-dialer-secret read from app_settings, and an explicit 30 s timeout instead
-- of pg_net's 5 s default. Idempotent: unscheduled by name only if it exists,
-- then rescheduled, so re-running this migration is safe.
--
-- 30 minutes matches the cadence the Windows task used. The reconcile is a
-- full diff of the pool against both Trust Hub containers and is idempotent, so
-- a skipped run costs nothing but the delay.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- shaken-reconcile: every 30 minutes -> /api/shaken/reconcile ---------------
select cron.unschedule(jobid)
from cron.job
where jobname = 'shaken-reconcile';

select cron.schedule(
  'shaken-reconcile',
  '*/30 * * * *',
  $cmd$
  select net.http_post(
    url := 'https://www.smile-and-dial.com/api/shaken/reconcile',
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
