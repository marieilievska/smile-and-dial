-- Recordings are now PULLED from the ElevenLabs API instead of pushed to us.
--
-- ElevenLabs delivered the call recording as a base64 MP3 inside the JSON body
-- of its post_call_audio webhook. Vercel rejects request bodies over 4.5 MB
-- before the route runs (HTTP 413), so the recording was silently lost for
-- most calls longer than ~3 minutes. The post-call handler now fetches the
-- audio from GET /v1/convai/conversations/{id}/audio after the transcript
-- lands, and the dialer tick sweeps for calls still missing one
-- (src/lib/elevenlabs/recording-fetch.ts).
--
-- These two columns give that sweep a bounded retry budget and leave a visible
-- reason on the row when it gives up, instead of a recording that is just
-- quietly absent.

alter table public.calls
  add column if not exists recording_fetch_attempts integer not null default 0,
  add column if not exists recording_fetch_error text;

comment on column public.calls.recording_fetch_attempts is
  'How many times we have tried to pull this call''s recording from the '
  'ElevenLabs API. The tick sweep stops retrying at 5.';
comment on column public.calls.recording_fetch_error is
  'Why the last recording fetch failed (reason: detail). Cleared when a '
  'recording is stored.';

-- The sweep runs every minute and only ever wants completed AI calls that are
-- still missing a recording. Index exactly that slice so the scan stays tiny
-- however large `calls` grows; rows leave the index the moment a recording
-- lands.
create index if not exists calls_recording_backfill_idx
  on public.calls (recording_fetch_attempts, created_at desc)
  where recording_path is null
    and elevenlabs_conversation_id is not null
    and status = 'completed'
    and call_mode = 'ai';
