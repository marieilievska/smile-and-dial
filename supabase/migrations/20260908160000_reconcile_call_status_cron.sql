-- Reconcile failed calls against Twilio, every 15 minutes.
--
-- Outbound calls are placed by ElevenLabs through its native Twilio
-- integration, and every number's StatusCallback points at ElevenLabs rather
-- than at us:
--
--     status_webhook_url -> https://api.elevenlabs.io/twilio/status-callback
--
-- That is deliberate and is not moving (pointing it back at the app is what
-- silently killed inbound in #222). The consequence is that our own Twilio
-- status webhook -- which already maps busy -> busy and no-answer -> no_answer
-- correctly -- NEVER RUNS for these calls. Every outcome arrives from
-- ElevenLabs' post-call webhook instead, and ElevenLabs reports anything that
-- did not connect as a flat `failed`.
--
-- Measured against Twilio's own call records on 2026-09-08, of 84 calls we had
-- marked status='failed': 47 really were failed, 22 were no-answer and 15 were
-- busy. 37 of 84 were an unanswered or engaged phone wearing a failure label.
-- The same day the app recorded 87 `failed` and 5 no_answer/busy combined.
--
-- Two things were wrong because of it. The funnel counted ordinary dialing
-- outcomes as failures; and pre_call_check counts a campaign's day with
-- `status <> 'failed'`, so a phone that rang and rang cost nothing against
-- calls_per_day_cap.
--
-- /api/maintenance/reconcile-call-status closes the loop by ASKING Twilio after
-- the fact, re-labelling from the same map the status webhook would have used.
-- Its schedule lives here, not in a local task, for the reason spelled out in
-- 20260908120000_shaken_reconcile_cron.sql: pg_cron is WATCHED. evaluate_alerts()
-- raises `cron_missed` for any job whose last run is older than 3x its own
-- schedule. A backstop nothing can see stopping is how ten numbers dialled for
-- six days without A-attestation.
--
-- WHY 15 MINUTES. The reconcile is only worth running after a call has ended,
-- and our row is written by the post-call webhook within seconds of that, with
-- Twilio's call resource already final. So the cadence buys nothing but
-- freshness: at 15 minutes a mislabelled call is corrected within a quarter of
-- an hour -- comfortably inside the same ET dialing day, which is what matters
-- for the daily cap -- while a run costs only as many Twilio reads as there
-- were failures in the last three hours (single digits, typically). Every
-- minute would multiply those reads by fifteen for no gain; hourly would let a
-- morning's worth of miscounted calls sit under the cap.
--
-- The endpoint's own default window is three hours, not the reconciler's 48:
-- a reconciled row leaves the working set immediately, so only the genuinely
-- failed rows are ever re-read, and a wide window would re-ask Twilio about the
-- same dead calls ~96 times a day. Three hours gives each call twelve chances.
-- The one-off backfill posts its own wider `sinceHours` by hand.
--
-- Same pattern as every other HTTP cron here: pg_net POST to the canonical host
-- (https://www.smile-and-dial.com -- the throwaway Vercel alias only works
-- while Vercel keeps it attached; see 20260905171000_crons_canonical_host.sql),
-- the x-dialer-secret read from app_settings, and an explicit 30 s timeout
-- instead of pg_net's 5 s default. Idempotent: unscheduled by name only if it
-- exists, then rescheduled, so re-running this migration is safe.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- reconcile-call-status: every 15 min -> /api/maintenance/reconcile-call-status
select cron.unschedule(jobid)
from cron.job
where jobname = 'reconcile-call-status';

select cron.schedule(
  'reconcile-call-status',
  '*/15 * * * *',
  $cmd$
  select net.http_post(
    url := 'https://www.smile-and-dial.com/api/maintenance/reconcile-call-status',
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
