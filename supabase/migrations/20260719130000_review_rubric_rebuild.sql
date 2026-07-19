-- Rebuild the review rubric around what the operator actually reviews for.
--
-- The old rubric was 30 flags doing three unrelated jobs at once: bug detection
-- (impossible — the reviewer only ever sees plain transcript text, so timing and
-- tool-call flags were guesses), customer-insight capture (VOC — nothing in the
-- app ever read those), and agent coaching. On top of that, `off_script` asked
-- the model to compare a call against ~17k characters of prompt with no notion
-- of which parts were binding, so it fired on correct behaviour: the agents'
-- prompts state outright that their sample lines are calibration and must never
-- be repeated verbatim.
--
-- What replaces it: per-agent playbook steps (derived from each agent's own
-- prompt — see 20260719120000) plus a small fixed set of delivery checks that
-- hold for any agent. Retired flags are DEACTIVATED, never deleted, so existing
-- flag rows keep their foreign key and can be reinstated with one update.

-- 1. A playbook finding is per-step, so a call can miss several distinct steps.
--    step_key is NOT NULL DEFAULT '' rather than nullable so the uniqueness rule
--    stays a plain column constraint that upserts can target by name.
alter table public.call_review_flags
  add column if not exists step_key text not null default '',
  add column if not exists step_title text;

comment on column public.call_review_flags.step_key is
  'Playbook step this finding is about; empty string for the fixed delivery checks.';
comment on column public.call_review_flags.step_title is
  'Human label of the step at the time of review, so findings stay readable after a prompt edit.';

alter table public.call_review_flags
  drop constraint if exists call_review_flags_call_id_flag_key_key;

alter table public.call_review_flags
  drop constraint if exists call_review_flags_call_flag_step_key;
alter table public.call_review_flags
  add constraint call_review_flags_call_flag_step_key
  unique (call_id, flag_key, step_key);

create index if not exists call_review_flags_step_idx
  on public.call_review_flags (flag_key, step_key);

-- 2. The new rubric.
insert into public.review_flag_defs (key, label, lens, severity, guidance, active, is_candidate, sort_order)
values
  ('playbook_missed', 'Skipped a required step', 'quality', 2,
   'The agent skipped a step its own playbook required, in a situation where that step actually applied.',
   true, false, 5),

  ('reasked_known_info', 'Asked something they''d already said', 'quality', 2,
   'The agent asked for something this same person already told them earlier on this call.',
   true, false, 10),
  ('repeated_itself', 'Repeated itself', 'quality', 2,
   'The agent said substantially the same thing twice, or got stuck in a loop.',
   true, false, 11),
  ('canned_delivery', 'Sounded scripted', 'quality', 2,
   'The agent sounded recited rather than conversational — marketing voice, slick value-prop phrasing, or its playbook''s sample lines delivered near word-for-word.',
   true, false, 12),
  ('pushy_after_no', 'Kept pushing after a no', 'quality', 2,
   'The person declined or tried to end the call and the agent kept pitching.',
   true, false, 13),
  ('monologued', 'Monologued', 'quality', 3,
   'The agent stacked several points into one turn instead of asking one thing and handing the turn back.',
   true, false, 14),
  ('talked_over', 'Talked over them', 'quality', 3,
   'The person started speaking and the agent kept going instead of stopping and following them.',
   true, false, 15)
on conflict (key) do update set
  label = excluded.label,
  lens = excluded.lens,
  severity = excluded.severity,
  guidance = excluded.guidance,
  active = true,
  is_candidate = false,
  sort_order = excluded.sort_order;

-- Sharpen the wording of the flags we're keeping.
update public.review_flag_defs
   set guidance = 'The person asked not to be called / to stop, and the agent kept pitching instead of confirming removal and ending the call.',
       active = true, is_candidate = false, sort_order = 1
 where key = 'dnc_not_honored';
update public.review_flag_defs
   set active = true, is_candidate = false, sort_order = 2
 where key in ('misleading_claim', 'overpromised');
update public.review_flag_defs
   set active = true, is_candidate = false, sort_order = 3
 where key = 'wrong_data_used';

-- 3. Retire the rest. VOC and opportunity flags were never read by any screen;
--    the bug flags need timing/tool data the reviewer is never given; the old
--    quality flags are superseded by the sharper ones above.
--    `no_conversation` stays active on purpose — it is applied deterministically
--    at enqueue time without an LLM, and the code keeps it out of the AI's list.
update public.review_flag_defs
   set active = false
 where key in (
   'off_script',
   'booking_failed_then_recovered', 'tool_error', 'dead_air',
   'dropped_midconversation', 'agent_looped', 'transfer_failed',
   'wrong_info_given', 'fumbled_objection', 'rambled_unclear',
   'pushy_or_rude', 'off_goal', 'didnt_confirm_details', 'awkward_delivery',
   'hot_lead_not_booked', 'decision_maker_no_ask',
   'callback_promised_not_scheduled', 'goal_met_needs_followup',
   'price_objection', 'not_interested_reason', 'competitor_mentioned',
   'software_mentioned', 'feature_or_need_request', 'strong_interest',
   'confused_by_offer'
 );
