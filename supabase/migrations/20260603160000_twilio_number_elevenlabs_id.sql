-- Native ElevenLabs Twilio calling: store the ElevenLabs phone_number_id that
-- corresponds to each Twilio number we own. ElevenLabs places outbound calls
-- via POST /v1/convai/twilio/outbound-call, which requires an
-- agent_phone_number_id — the id ElevenLabs returns when the Twilio number is
-- imported into the workspace (POST /v1/convai/phone-numbers). We import each
-- number lazily on first dial and cache the id here so we only import once.
alter table public.twilio_numbers
  add column if not exists elevenlabs_phone_number_id text;

comment on column public.twilio_numbers.elevenlabs_phone_number_id is
  'ElevenLabs phone_number_id for native Twilio outbound calling. Populated lazily on first dial via POST /v1/convai/phone-numbers.';
