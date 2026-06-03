-- Store the ElevenLabs post-call webhook id + signing secret in the DB.
--
-- The post-call webhook delivers each conversation's transcript, recording,
-- summary, extracted data, and disposition. Wiring it needs two values from
-- ElevenLabs: the workspace webhook's id (attached to our agents so only OUR
-- conversations post to us) and its HMAC signing secret (to validate the
-- incoming events). These were read from env vars, but this project's Vercel
-- env store has repeatedly failed to persist values — leaving signature
-- validation broken (every event 403s) and the id unset (agents never post).
-- Keeping them in app_settings (DB writes are reliable) removes that
-- dependency. The env vars still win when set; the DB value is the fallback.

alter table public.app_settings
  add column if not exists elevenlabs_post_call_webhook_id text,
  add column if not exists elevenlabs_post_call_webhook_secret text;
