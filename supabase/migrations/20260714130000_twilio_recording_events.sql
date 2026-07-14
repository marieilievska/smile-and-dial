-- Idempotency log for Twilio recording webhooks.
--
-- Twilio delivers the recording callback at-least-once and retries on any
-- non-2xx. Without a dedup guard, each delivery re-downloads the recording and
-- re-runs Whisper transcription + the gpt-4o-mini summary — real OpenAI spend
-- every time — and re-writes the call's cost_breakdown. The recording_sid
-- primary key gives at-most-once processing: the /api/twilio/recording handler
-- inserts here FIRST and bails on a unique-violation. Mirrors
-- twilio_status_events.

create table public.twilio_recording_events (
  recording_sid text primary key,
  call_sid text,
  received_at timestamptz not null default now()
);

comment on table public.twilio_recording_events is
  'Idempotency log for Twilio recording callbacks. The recording_sid primary '
  'key prevents re-transcribing (paid) when Twilio retries delivery.';

create index twilio_recording_events_received_at_idx
  on public.twilio_recording_events (received_at desc);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
-- Written exclusively by the /api/twilio/recording route handler using the
-- service role (which bypasses RLS). No authenticated user — admin or member —
-- has a reason to read or write it, so RLS is enabled with no policies. Reading
-- rolls back to "no access" by default.
alter table public.twilio_recording_events enable row level security;
