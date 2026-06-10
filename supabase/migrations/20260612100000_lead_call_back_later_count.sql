-- Give "call_back_later" its own retry counter, independent of the unified
-- voicemail/no-answer cycle's `retry_counter`.
--
-- Bug #10: the call_back_later branch was computing its attempt number from
-- `retry_counter` — the SAME counter the voicemail/no-answer unified cycle
-- increments. So a lead with a couple of prior voicemails who then says
-- "call me back later" jumped straight to the 15-day rest instead of getting
-- its own short next-day cycle. A human asking to be called back later should
-- get its OWN cadence regardless of any prior voicemail history.
alter table public.leads
  add column if not exists call_back_later_count integer not null default 0;

comment on column public.leads.call_back_later_count is
  'Number of "call_back_later" (busy brush-off) attempts on this lead, tracked '
  'independently of retry_counter (the voicemail/no-answer unified cycle). '
  'Drives the call_back_later next-day retry cadence; reset when the lead '
  'progresses to any other terminal/resting state.';
