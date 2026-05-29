-- Round L2 — track the webhook URLs Twilio has on file for each
-- number, so the Twilio Numbers page can show "webhooks point at
-- us / point elsewhere / not set" without having to round-trip to
-- Twilio on every page load.
--
-- Populated by:
--   1. purchaseNumber — after buying a number, the action PATCHes
--      Twilio with our voice + status URLs and stamps them here.
--   2. repointNumberWebhooks — per-row action to re-point an
--      existing number (useful when the deployment URL changes).
--   3. syncFromTwilio — pulls every number in the Twilio account
--      and refreshes these columns so the admin can spot drift.

alter table public.twilio_numbers
  add column if not exists voice_webhook_url text,
  add column if not exists status_webhook_url text;
