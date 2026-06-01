-- ---------------------------------------------------------------------------
-- Make the ElevenLabs webhook idempotency key per-(conversation, event type).
--
-- Originally conversation_id alone was the primary key — "one webhook per
-- conversation". That's no longer true: with Transcript + Audio (+ call-
-- initiation-failure) events enabled, MULTIPLE webhooks arrive for the same
-- conversation_id, each a different `type`. Under the old PK the audio event
-- would collide with the transcript event and be silently dropped as a
-- duplicate.
--
-- New idempotency key: (conversation_id, event_type). A replay of the SAME
-- event type still collapses to one; different types for one conversation
-- now each get processed once.
-- ---------------------------------------------------------------------------
alter table public.elevenlabs_webhook_events
  add column if not exists event_type text not null default 'post_call_transcription';

alter table public.elevenlabs_webhook_events
  drop constraint elevenlabs_webhook_events_pkey;

alter table public.elevenlabs_webhook_events
  add primary key (conversation_id, event_type);

comment on table public.elevenlabs_webhook_events is
  'Idempotency log for ElevenLabs webhooks. Keyed on (conversation_id, '
  'event_type) so transcript / audio / failure events for one conversation '
  'are each processed once while same-type retries collapse.';
