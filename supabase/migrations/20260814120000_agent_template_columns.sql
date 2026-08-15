-- Template-based agent builder (Phase 1). Adds the "script layer" columns.
-- The locked instructions are snapshotted onto the agent at creation so editing
-- a template later never silently changes live agents.
alter table public.agents
  add column if not exists template_key text,
  add column if not exists instructions text,
  add column if not exists prompt_purpose text,
  add column if not exists key_details jsonb not null default '[]'::jsonb,
  add column if not exists script_prose text;

comment on column public.agents.template_key is
  'Which starting template this agent was built from (webinar, blank, …). Null for legacy wizard-built agents.';
comment on column public.agents.instructions is
  'Snapshot of the locked behavioral instructions at creation time.';
comment on column public.agents.key_details is
  'Editable typed facts the agent uses: [{id,label,type,value,required}].';
