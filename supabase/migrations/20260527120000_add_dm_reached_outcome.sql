-- Add the "dm_reached" (decision-maker reached) outcome to the
-- allowed values on both `leads.last_outcome` and `calls.outcome`.
--
-- Used when the AI / operator has confirmed they spoke with the actual
-- decision maker for a lead. Distinct from "gatekeeper" (a non-DM
-- screening the call) and from "goal_met" (DM agreed to the booking).
-- Useful to filter for as a "warm pipeline" cohort separate from
-- gatekeeper-only conversations.

alter table public.leads drop constraint if exists leads_last_outcome_check;
alter table public.leads
  add constraint leads_last_outcome_check check (
    last_outcome is null
    or last_outcome in (
      'voicemail', 'no_answer', 'busy', 'failed', 'hung_up_immediately',
      'invalid_number', 'gatekeeper', 'not_interested', 'callback', 'dnc',
      'goal_met', 'language_barrier', 'ai_receptionist', 'ai_error',
      'transferred_to_human', 'dm_reached'
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
      'transferred_to_human', 'dm_reached'
    )
  );
