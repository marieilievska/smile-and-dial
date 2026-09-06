-- The SMS-capable numbers a user's Close account can text from.
--
-- Product decision (owner, 2026-09-05): the send-from number is not something
-- a user types in -- "it's whatever number we choose from Close directly". So
-- the app reads the organisation's numbers from Close's phone-number endpoint
-- (GET /api/v1/phone_number/: number, sms_enabled, type, user_id, label) when
-- the account is connected, on "Refresh numbers", and once at send time when
-- nothing is stored yet. The SMS-capable ones are kept here so the Close card
-- can offer a picker without another round-trip; the chosen one stays in
-- close_sms_from_number (20260620xxxx), which the send_text tool reads.
--
-- Shape: a JSON array of
--   { number, formatted, label, userId, isGroup }
-- see src/lib/close/sms-from-number.ts (parseCloseSmsNumbers).

alter table public.user_integrations
  add column if not exists close_sms_numbers jsonb;

comment on column public.user_integrations.close_sms_numbers is
  'SMS-capable numbers in this user''s Close account, as listed by GET '
  '/api/v1/phone_number/ (sms_enabled + type internal). Array of {number, '
  'formatted, label, userId, isGroup}. Refreshed on connect / "Refresh '
  'numbers"; close_sms_from_number holds the one the agent texts from.';
