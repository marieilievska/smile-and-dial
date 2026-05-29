-- Round L1 — the ElevenLabs API key moved from app_settings into the
-- server env (`ELEVENLABS_API_KEY`). Smile & Dial uses a single
-- ElevenLabs account behind the whole product, so per-tenant
-- configuration was the wrong shape.
--
-- The column is dropped (not just blanked) so a future code path
-- can't accidentally read a stale value. The voice-id allowlist
-- (elevenlabs_voice_ids) stays — it's per-workspace.

alter table public.app_settings
  drop column if exists elevenlabs_api_key;
