-- Move the ElevenLabs server-tool webhook secret into the database.
--
-- The secret is used in two places: baked as the `x-tool-secret` header on
-- each registered tool, and validated by the tool webhook on every call.
-- It was read from ELEVENLABS_TOOL_WEBHOOK_SECRET, but this project's Vercel
-- env store has repeatedly failed to persist values — leaving the secret
-- empty, which makes ensureServerTools() a silent no-op (no tools get
-- created or attached). Storing it in app_settings (DB writes are reliable)
-- removes that dependency. The env var still wins when set (override); the DB
-- value is the fallback, auto-generated here so it's never empty.

alter table public.app_settings
  add column if not exists elevenlabs_tool_webhook_secret text;

update public.app_settings
  set elevenlabs_tool_webhook_secret =
    'sd_tool_' ||
    replace(gen_random_uuid()::text, '-', '') ||
    replace(gen_random_uuid()::text, '-', '')
  where id = 1
    and coalesce(elevenlabs_tool_webhook_secret, '') = '';
