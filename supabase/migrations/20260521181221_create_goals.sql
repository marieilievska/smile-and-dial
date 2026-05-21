-- Goals: what a campaign's calls are trying to accomplish. A campaign picks
-- one goal, and the goal drives the agent's scoring criterion.
-- See BUILD_PLAN.md Section 3 (goals) and Section 5.4.

create table public.goals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

comment on table public.goals is 'Call goals — what an agent tries to accomplish.';

create index goals_owner_id_idx on public.goals (owner_id);

-- ---------------------------------------------------------------------------
-- Row-Level Security: members manage their own goals; admins manage all.
-- ---------------------------------------------------------------------------
alter table public.goals enable row level security;

create policy "goals_select"
  on public.goals
  for select
  to authenticated
  using (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

create policy "goals_insert"
  on public.goals
  for insert
  to authenticated
  with check (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

create policy "goals_update"
  on public.goals
  for update
  to authenticated
  using (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  )
  with check (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

create policy "goals_delete"
  on public.goals
  for delete
  to authenticated
  using (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- Seed the default "Schedule appointment" goal, owned by the first admin.
-- ---------------------------------------------------------------------------
insert into public.goals (owner_id, name, description, is_default)
select id,
  'Schedule appointment',
  'The lead agrees to a specific date and time for an appointment.',
  true
from public.profiles
where role = 'admin'
order by created_at
limit 1;
