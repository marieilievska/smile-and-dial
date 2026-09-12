-- A copy of each Calendly event type's open times, so the in-call
-- get_available_times tool answers from our own database instead of waiting on
-- Calendly while the caller listens to silence.
--
-- Measured 2026-09-11: the tool took 1.80 s at the median, of which Calendly's
-- event_type_available_times call was 1.0-1.4 s. On 2026-09-10, five of the six
-- people who reached that step and did not book hung up during the pause.
--
-- Additive and reversible: the columns are nullable, a null copy simply means
-- "never read", and the tool falls back to the live fetch it does today.
-- Freshness rules live in src/lib/calendly/copy-rules.ts; the dialer keeps the
-- copy warm while it is placing calls (src/lib/calendly/copy-store.ts).
alter table public.calendly_event_types
  add column if not exists availability_slots jsonb,
  add column if not exists availability_fetched_at timestamptz;

comment on column public.calendly_event_types.availability_slots is
  'Open slot start times (ISO 8601 strings) from the last read of Calendly''s event_type_available_times. Newest read wins; null means never read.';

comment on column public.calendly_event_types.availability_fetched_at is
  'When availability_slots was last read from Calendly. Null means never.';
