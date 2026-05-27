-- Workspace-wide do-not-call list, and an audit log of who removed
-- numbers from it. See BUILD_PLAN.md Section 3 (dnc_entries, dnc_removals)
-- and Section 5.7.

create table public.dnc_entries (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,
  company_snapshot text,
  reason text not null check (
    reason in (
      'dnc_requested', 'invalid_number', 'language_barrier',
      'manual', 'imported'
    )
  ),
  added_by_user_id uuid references auth.users (id) on delete set null,
  -- FK to calls (id) is added when the calls table arrives in Phase 4.
  source_call_id uuid,
  added_at timestamptz not null default now()
);

comment on table public.dnc_entries is 'Workspace-wide do-not-call list.';

create index dnc_entries_added_at_idx on public.dnc_entries (added_at desc);

create table public.dnc_removals (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  removed_by_user_id uuid not null references auth.users (id),
  reason_text text not null,
  removed_at timestamptz not null default now()
);

comment on table public.dnc_removals is 'Audit log of every DNC removal, with reason text.';

create index dnc_removals_removed_at_idx
  on public.dnc_removals (removed_at desc);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
alter table public.dnc_entries enable row level security;

-- DNC is workspace-wide; anyone signed in can see and add to it. Removing
-- requires admin (it's logged separately in dnc_removals).
create policy "dnc_entries_select"
  on public.dnc_entries
  for select
  to authenticated
  using (true);

create policy "dnc_entries_insert"
  on public.dnc_entries
  for insert
  to authenticated
  with check (true);

create policy "dnc_entries_delete"
  on public.dnc_entries
  for delete
  to authenticated
  using (public.is_admin((select auth.uid())));

alter table public.dnc_removals enable row level security;

create policy "dnc_removals_select"
  on public.dnc_removals
  for select
  to authenticated
  using (public.is_admin((select auth.uid())));

create policy "dnc_removals_insert"
  on public.dnc_removals
  for insert
  to authenticated
  with check (public.is_admin((select auth.uid())));

-- ---------------------------------------------------------------------------
-- Dial-time enforcement helper. The dialer (Phase 4) calls this before
-- firing an outbound call; for now it gives us a single source of truth.
-- ---------------------------------------------------------------------------
create or replace function public.is_phone_on_dnc(phone_to_check text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.dnc_entries where phone = phone_to_check
  );
$$;

grant execute on function public.is_phone_on_dnc(text) to authenticated;
