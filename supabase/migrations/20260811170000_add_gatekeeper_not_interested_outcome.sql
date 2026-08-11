-- A gatekeeper (receptionist / front desk / staff — NOT the owner) who FIRMLY
-- declined the offer on the business's behalf. Distinct from:
--   - gatekeeper: a non-decision-maker who just couldn't connect us (retry)
--   - not_interested: the OWNER/decision-maker declined (implies DM reached)
-- gatekeeper_not_interested rests the lead (stop calling) WITHOUT implying we
-- reached the decision-maker. Behaviour lives in code; this just allows the value.
--
-- Additive only. leads.last_outcome was dropped (20260612120000), so calls is the
-- only table with an outcome CHECK constraint now.
alter table public.calls drop constraint if exists calls_outcome_check;
alter table public.calls
  add constraint calls_outcome_check check (
    outcome is null
    or outcome in (
      'voicemail', 'no_answer', 'busy', 'failed', 'hung_up_immediately',
      'hung_up_later', 'invalid_number', 'gatekeeper', 'gatekeeper_not_interested',
      'not_interested', 'callback', 'dnc', 'goal_met', 'language_barrier',
      'ai_receptionist', 'ai_error', 'transferred_to_human', 'dm_reached',
      'call_back_later'
    )
  );
