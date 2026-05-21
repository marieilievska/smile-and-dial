-- Custom field definitions: admin-defined fields appended to every lead.
-- See BUILD_PLAN.md Section 3 (custom_field_defs).

create table public.custom_field_defs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  type text not null check (
    type in ('text', 'number', 'date', 'boolean', 'select')
  ),
  options jsonb not null default '[]'::jsonb,
  required boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

comment on table public.custom_field_defs is 'Admin-defined custom fields for leads.';

-- ---------------------------------------------------------------------------
-- Row-Level Security: every authenticated user can read the definitions
-- (needed to render custom fields on leads); only admins may manage them.
-- ---------------------------------------------------------------------------
alter table public.custom_field_defs enable row level security;

create policy "custom_field_defs_select"
  on public.custom_field_defs
  for select
  to authenticated
  using (true);

create policy "custom_field_defs_insert"
  on public.custom_field_defs
  for insert
  to authenticated
  with check (public.is_admin((select auth.uid())));

create policy "custom_field_defs_update"
  on public.custom_field_defs
  for update
  to authenticated
  using (public.is_admin((select auth.uid())))
  with check (public.is_admin((select auth.uid())));

create policy "custom_field_defs_delete"
  on public.custom_field_defs
  for delete
  to authenticated
  using (public.is_admin((select auth.uid())));
