-- Close inbound-webhook subscription, per user (Close API keys are per user, so
-- the subscription and its signing key are too). Created by the app via
-- POST /api/v1/webhook/; the signature_key Close returns verifies every
-- delivery to /api/close/webhook?u=<user_id>.
alter table public.user_integrations
  add column if not exists close_webhook_id text,
  add column if not exists close_webhook_signature_key text,
  add column if not exists close_webhook_created_at timestamptz;
