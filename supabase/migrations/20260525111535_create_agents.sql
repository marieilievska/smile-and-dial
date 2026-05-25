-- Agents: our copy of an AI agent's configuration. Mirrored to ElevenLabs
-- on save (in a later step). See BUILD_PLAN.md Section 3 (agents) and
-- Section 9 (Agent Builder).

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  elevenlabs_agent_id text,
  voice_id text,
  ai_model text,
  -- The assembled 6-block prompt that gets pushed to ElevenLabs.
  system_prompt text,
  -- Raw wizard inputs, kept for re-editing.
  prompt_personality text,
  prompt_environment text,
  prompt_tone text,
  prompt_goal text,
  prompt_guardrails text,
  -- { send_email: bool, schedule_callback: bool, ... }
  tools_enabled jsonb not null default '{}'::jsonb,
  -- Array of knowledge_bases.id values. Postgres can't enforce an FK on
  -- array elements; the app is responsible for keeping the list valid.
  knowledge_base_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.agents is 'AI agent configurations, mirrored to ElevenLabs.';

create index agents_owner_id_idx on public.agents (owner_id);

create trigger agents_set_updated_at
  before update on public.agents
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row-Level Security: agents are admin-managed.
-- ---------------------------------------------------------------------------
alter table public.agents enable row level security;

create policy "agents_select"
  on public.agents
  for select
  to authenticated
  using (public.is_admin((select auth.uid())));

create policy "agents_insert"
  on public.agents
  for insert
  to authenticated
  with check (public.is_admin((select auth.uid())));

create policy "agents_update"
  on public.agents
  for update
  to authenticated
  using (public.is_admin((select auth.uid())))
  with check (public.is_admin((select auth.uid())));

create policy "agents_delete"
  on public.agents
  for delete
  to authenticated
  using (public.is_admin((select auth.uid())));
