-- Split the single "hung_up_immediately" bucket into an immediate hang-up (they
-- hung up during/right after the greeting, no real reply, <=15s) and a later one
-- ("hung_up_later" — they said something back OR stayed on the line past 15s,
-- then hung up). The classification is derived in code (classify-outcome.ts);
-- this migration just allows the new value.
--
-- Additive only. leads.last_outcome was dropped (20260612120000), so calls is the
-- only table with an outcome CHECK constraint now.
alter table public.calls drop constraint if exists calls_outcome_check;
alter table public.calls
  add constraint calls_outcome_check check (
    outcome is null
    or outcome in (
      'voicemail', 'no_answer', 'busy', 'failed', 'hung_up_immediately',
      'hung_up_later', 'invalid_number', 'gatekeeper', 'not_interested',
      'callback', 'dnc', 'goal_met', 'language_barrier', 'ai_receptionist',
      'ai_error', 'transferred_to_human', 'dm_reached', 'call_back_later'
    )
  );
