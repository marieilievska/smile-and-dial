-- Calendly webhook signing key (fallback for CALENDLY_WEBHOOK_SIGNING_KEY; env wins when set).
alter table public.app_settings
  add column if not exists calendly_webhook_signing_key text;
