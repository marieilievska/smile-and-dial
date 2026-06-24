-- Keep inbound working: re-assert our Twilio voice/status webhooks periodically.
--
-- ElevenLabs silently re-hijacks an imported number's Twilio voice webhook to
-- its own inbound handler (api.elevenlabs.io/twilio/inbound_call) — sometimes
-- long after the initial import — which breaks our app-bridged inbound. Our
-- import helper only re-points on first import, so this cron is the backstop:
-- every 10 minutes it POSTs /api/twilio/repoint-inbound, which re-points every
-- active number back at the app. Idempotent (a correct number is a no-op write).
--
-- Mirrors the other crons: pg_net POST with the dialer_tick_secret as the
-- x-dialer-secret header; the endpoint rejects an empty/wrong secret (401).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid)
from cron.job
where jobname = 'inbound-webhook-guard';

select cron.schedule(
  'inbound-webhook-guard',
  '*/10 * * * *',
  $cmd$
  select net.http_post(
    url := 'https://referrizer-smile-and-dial.vercel.app/api/twilio/repoint-inbound',
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
