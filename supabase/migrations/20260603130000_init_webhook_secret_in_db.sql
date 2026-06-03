-- Store the ElevenLabs conversation-initiation webhook secret in the DB.
--
-- This webhook feeds per-call context (call_type, last summary, lead name,
-- transfer number, the internal call_id the tools need) to the agent at the
-- START of every conversation. It was gated on ELEVENLABS_INIT_WEBHOOK_SECRET,
-- but this project's Vercel env store has been unreliable — leaving the secret
-- empty, which made the per-agent init webhook never get attached, so agents
-- fell back to the workspace default (pointed at the old smile-and-dial-V2
-- project) and started calls "blind". Storing it in app_settings (reliable DB
-- writes) fixes that. The env var still wins; the DB value is the fallback and
-- is auto-generated here so it's never empty.

alter table public.app_settings
  add column if not exists elevenlabs_init_webhook_secret text;

update public.app_settings
  set elevenlabs_init_webhook_secret =
    'sd_init_' ||
    replace(gen_random_uuid()::text, '-', '') ||
    replace(gen_random_uuid()::text, '-', '')
  where id = 1
    and coalesce(elevenlabs_init_webhook_secret, '') = '';
