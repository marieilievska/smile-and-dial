-- Voicemail escalation counter on callbacks (BUILD_PLAN §8 callback
-- voicemail special case):
--   1st VM at callback → push 30 min, retry
--   2nd VM → schedule next day same time
--   3rd VM → Resting 15 days, callback marked `missed`

alter table public.callbacks
  add column voicemail_attempts integer not null default 0;

comment on column public.callbacks.voicemail_attempts is
  'How many times the dialer has hit voicemail on this callback. The '
  'retry engine reads + bumps this to drive the 30min / next-day / '
  'Resting-15-days escalation.';
