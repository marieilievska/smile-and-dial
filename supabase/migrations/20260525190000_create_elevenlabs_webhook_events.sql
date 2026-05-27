-- Idempotency log for ElevenLabs post-call webhooks.
--
-- ElevenLabs sends one post-call webhook per conversation when the call
-- ends. They retry on non-2xx, so we need each conversation_id to be
-- processed at most once. Unlike Twilio's status callbacks (where many
-- events share a CallSid), here the conversation_id alone is the idempotency
-- key — one webhook per conversation, full stop.

create table public.elevenlabs_webhook_events (
  conversation_id text primary key,
  received_at timestamptz not null default now(),
  raw_payload jsonb
);

comment on table public.elevenlabs_webhook_events is
  'Idempotency log for ElevenLabs post-call webhooks. conversation_id is '
  'the primary key — one webhook per conversation, so retries collapse to '
  'a single applied event.';

create index elevenlabs_webhook_events_received_at_idx
  on public.elevenlabs_webhook_events (received_at desc);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
-- Like twilio_status_events, this is service-role-only. RLS enabled with no
-- policies means REST callers see nothing; the route handler bypasses RLS
-- via the service role key.
alter table public.elevenlabs_webhook_events enable row level security;
