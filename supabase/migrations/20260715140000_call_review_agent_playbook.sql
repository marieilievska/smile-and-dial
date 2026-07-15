-- Call Reviewer: agent-playbook-aware review. Additive.
-- Cache each agent's effective instructions for the reviewer, and seed the
-- built-in "off_script" flag (agent didn't follow its own instructions).
alter table public.agents
  add column if not exists review_prompt text,
  add column if not exists review_prompt_at timestamptz;

insert into public.review_flag_defs (key, label, lens, severity, guidance, sort_order)
values (
  'off_script',
  'Off-script — didn''t follow instructions',
  'quality',
  2,
  'The agent did not follow its own instructions/playbook for this call. Only evaluate when the agent''s instructions are provided; quote the transcript moment where it deviated.',
  100
)
on conflict (key) do nothing;
