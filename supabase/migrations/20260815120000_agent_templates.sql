-- Admin-curated shared agent templates (Phase 2, "save as template" flywheel).
-- Everyone reads (shared shelf); only admins write. Consumed alongside the
-- code-seeded templates (Blank, Webinar).
create table public.agent_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  instructions text not null,
  default_voice_id text,
  tools jsonb not null default '{}'::jsonb,
  script jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.agent_templates is
  'Admin-curated shared agent templates: locked instructions + editable script skeleton.';
comment on column public.agent_templates.script is
  '{purpose, goal, keyDetails:[{id,label,type,value,required}], scriptProse, dataCollection}';

create trigger agent_templates_set_updated_at
  before update on public.agent_templates
  for each row execute function public.set_updated_at();

alter table public.agent_templates enable row level security;

create policy "agent_templates_select"
  on public.agent_templates for select to authenticated
  using (true);

create policy "agent_templates_write"
  on public.agent_templates for all to authenticated
  using (public.is_admin((select auth.uid())))
  with check (public.is_admin((select auth.uid())));
