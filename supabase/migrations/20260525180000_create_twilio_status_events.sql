-- Idempotency log for Twilio status webhooks.
--
-- Twilio retries delivery of status callbacks on any non-2xx, and a single
-- call moves through several events (initiated → ringing → answered →
-- completed). We need each (CallSid, EventType) pair to be applied to the
-- `calls` row at most once. The primary key gives us that for free: the
-- route handler inserts here first and bails on a unique-violation.

create table public.twilio_status_events (
  call_sid text not null,
  event_type text not null,
  received_at timestamptz not null default now(),
  raw_payload jsonb,
  primary key (call_sid, event_type)
);

comment on table public.twilio_status_events is
  'Idempotency log for Twilio status callbacks. The (call_sid, event_type) '
  'primary key prevents double-processing when Twilio retries delivery.';

create index twilio_status_events_received_at_idx
  on public.twilio_status_events (received_at desc);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
-- This table is written exclusively by the /api/twilio/status route handler
-- using the service role (which bypasses RLS). No authenticated user — admin
-- or member — has a reason to read or write it, so RLS is enabled with no
-- policies. Reading rolls back to "no access" by default.
alter table public.twilio_status_events enable row level security;
