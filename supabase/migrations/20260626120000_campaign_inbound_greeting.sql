-- Per-campaign inbound greeting: the first line the agent speaks the instant
-- someone calls this campaign's number.
--
-- Inbound is ElevenLabs-native (the agent assigned to the number answers
-- directly). Without a first message the agent waits for the caller to speak
-- first while the caller waits for the business to speak — so inbound calls
-- open with dead air. The conversation-init webhook returns this value as a
-- per-call first_message override, keyed by the dialed number → its attached
-- campaign. NULL/blank falls back to a sensible default in the webhook, so no
-- inbound call is ever silent even before this field is filled in.
alter table public.campaigns
  add column if not exists inbound_greeting text;

comment on column public.campaigns.inbound_greeting is
  'First line the agent speaks on an inbound call to this campaign''s number. NULL = use the app''s default greeting.';
