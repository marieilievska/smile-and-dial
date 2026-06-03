-- Add "call_back_later": the person was busy / brushed us off ("not now")
-- WITHOUT agreeing to a real callback. Distinct from "callback" (a genuine
-- agreed callback, which counts as a real conversation/win) — call_back_later
-- is NEUTRAL (not a win, not decision-maker-reached) but we retry the next day
-- a couple of times before giving up. Keeps win-rate honest while still
-- chasing the lead.
alter table public.leads drop constraint if exists leads_last_outcome_check;
alter table public.leads
  add constraint leads_last_outcome_check check (
    last_outcome is null
    or last_outcome in (
      'voicemail', 'no_answer', 'busy', 'failed', 'hung_up_immediately',
      'invalid_number', 'gatekeeper', 'not_interested', 'callback', 'dnc',
      'goal_met', 'language_barrier', 'ai_receptionist', 'ai_error',
      'transferred_to_human', 'dm_reached', 'call_back_later'
    )
  );

alter table public.calls drop constraint if exists calls_outcome_check;
alter table public.calls
  add constraint calls_outcome_check check (
    outcome is null
    or outcome in (
      'voicemail', 'no_answer', 'busy', 'failed', 'hung_up_immediately',
      'invalid_number', 'gatekeeper', 'not_interested', 'callback', 'dnc',
      'goal_met', 'language_barrier', 'ai_receptionist', 'ai_error',
      'transferred_to_human', 'dm_reached', 'call_back_later'
    )
  );
