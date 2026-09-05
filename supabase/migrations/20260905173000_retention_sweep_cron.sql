-- Nightly retention sweep.
--
-- Product decision (2026-09-05): call audio and transcript text are kept in
-- OUR storage/database for 90 days, then removed from our side. The call row
-- itself — outcome, summary, extracted data, objection fields, cost — stays
-- forever. Older audio/transcripts remain in the ElevenLabs dashboard (the
-- agent's ElevenLabs retention is unlimited).
--
-- The same sweep prunes `elevenlabs_webhook_events`, the raw webhook payload
-- log. It only serves (conversation_id, event_type) idempotency and was
-- growing ~45 MB/day (152 MB after three days) with nothing ever deleting
-- from it; ElevenLabs never retries a 90-day-old event, so rows past the
-- window are dead weight.
--
-- Mirrors objection-extraction: pg_net POST with the dialer_tick_secret as
-- the x-dialer-secret header; the endpoint rejects an empty/wrong secret
-- (401). 03:30 UTC = 23:30 ET, after the calling day is well over.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Partial indexes so each nightly batch ("the oldest N calls that STILL have
-- a recording / transcript, created before the cutoff") is an index range
-- scan rather than a walk over every call ever placed. They only cover rows
-- still holding audio/transcripts, so they shrink as the sweep does its job.
create index if not exists calls_retention_recording_idx
  on public.calls (created_at)
  where recording_path is not null;

create index if not exists calls_retention_transcript_idx
  on public.calls (created_at)
  where transcript_json is not null;

-- (elevenlabs_webhook_events already has received_at indexed —
--  elevenlabs_webhook_events_received_at_idx — which covers its sweep.)

select cron.unschedule(jobid)
from cron.job
where jobname = 'retention-sweep';

select cron.schedule(
  'retention-sweep',
  '30 3 * * *',
  $cmd$
  select net.http_post(
    url := 'https://www.smile-and-dial.com/api/maintenance/retention',
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
