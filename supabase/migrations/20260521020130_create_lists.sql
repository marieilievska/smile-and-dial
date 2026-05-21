-- Lists: the grouping unit for leads. Every lead belongs to exactly one list,
-- and a list is the unit attached to a campaign. See BUILD_PLAN.md Sections 3-4.

create table public.lists (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now()
);

comment on table public.lists is 'Lead lists — the unit attached to campaigns.';

create index lists_owner_id_idx on public.lists (owner_id);

-- ---------------------------------------------------------------------------
-- Row-Level Security: members manage their own lists; admins manage all.
-- ---------------------------------------------------------------------------
alter table public.lists enable row level security;

create policy "lists_select"
  on public.lists
  for select
  to authenticated
  using (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

create policy "lists_insert"
  on public.lists
  for insert
  to authenticated
  with check (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

create policy "lists_update"
  on public.lists
  for update
  to authenticated
  using (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  )
  with check (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );

create policy "lists_delete"
  on public.lists
  for delete
  to authenticated
  using (
    owner_id = (select auth.uid()) or public.is_admin((select auth.uid()))
  );
