-- Per-agent review playbook.
--
-- The reviewer used to be handed an agent's whole system prompt as one flat
-- blob and asked "did the call follow this?", which made it flag correct
-- behaviour: the prompts explicitly say their sample lines are calibration and
-- must NOT be repeated verbatim, so saying it differently is required, and the
-- reviewer read that as going off-script.
--
-- Instead we now derive a short checklist of genuinely checkable steps from the
-- agent's OWN prompt, each marked rigid (must happen a specific way) or not.
-- Cached here keyed by a hash of the prompt it came from, so editing the prompt
-- re-derives on the next review rather than grading against a stale checklist.
alter table public.agents
  add column if not exists review_playbook jsonb,
  add column if not exists review_playbook_hash text,
  add column if not exists review_playbook_at timestamptz;

comment on column public.agents.review_playbook is
  'Derived checklist of required steps — see src/lib/review/playbook.ts.';
comment on column public.agents.review_playbook_hash is
  'sha256 of the system prompt review_playbook was derived from; a mismatch forces a re-derive.';
comment on column public.agents.review_playbook_at is
  'When review_playbook was last derived.';
