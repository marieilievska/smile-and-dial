-- ---------------------------------------------------------------------------
-- Per-agent custom data-collection fields + evaluation criteria.
--
-- The agent builder can now define extra ElevenLabs Data Collection fields
-- and Success Evaluation criteria per agent. These are ADDITIVE: the
-- system base set (disposition, business_email, owner/manager/employee
-- names, callback_datetime, objection_summary) and the "goal met" criterion
-- are always sent by the sync layer because the post-call webhook depends on
-- them (outcome mapping, lead autofill, callback scheduling). User-defined
-- fields/criteria are merged on top and never replace the base.
--
-- Stored as jsonb arrays so the shape can evolve without a migration:
--   extra_data_collection: [{ id, type, description, enum? }]
--   extra_evaluation:      [{ id, name, prompt }]
-- ---------------------------------------------------------------------------
alter table public.agents
  add column if not exists extra_data_collection jsonb not null default '[]'::jsonb,
  add column if not exists extra_evaluation jsonb not null default '[]'::jsonb;

comment on column public.agents.extra_data_collection is
  'User-defined ElevenLabs Data Collection fields, merged ON TOP of the '
  'system base set at sync time. Array of { id, type, description, enum? }.';
comment on column public.agents.extra_evaluation is
  'User-defined Success Evaluation criteria, merged on top of the base '
  '"goal met" criterion at sync time. Array of { id, name, prompt }.';
