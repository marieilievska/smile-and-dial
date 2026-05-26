-- System events: an immutable audit log of who changed what.
--
-- BUILD_PLAN §5.2 calls for the manual outcome override on the Calls page
-- to log to `system_events`. Same table will be useful as later steps add
-- more manual operations (callback cancellation, lead merge, etc.).
--
-- Append-only; no update or delete policy. Admins see everything, members
-- see only their own actions.

create table public.system_events (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  actor_user_id uuid references auth.users (id) on delete set null,
  ref_table text,
  ref_id uuid,
  payload jsonb,
  created_at timestamptz not null default now()
);

comment on table public.system_events is
  'Immutable audit log of manual state changes (outcome overrides, '
  'callback cancellations, merges, etc.).';

create index system_events_actor_idx
  on public.system_events (actor_user_id, created_at desc);
create index system_events_ref_idx
  on public.system_events (ref_table, ref_id, created_at desc);
create index system_events_kind_idx
  on public.system_events (kind, created_at desc);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
alter table public.system_events enable row level security;

create policy "system_events_select"
  on public.system_events
  for select
  to authenticated
  using (
    public.is_admin((select auth.uid()))
    or actor_user_id = (select auth.uid())
  );

-- Members can insert their own events; the actor must match the caller.
create policy "system_events_insert"
  on public.system_events
  for insert
  to authenticated
  with check (actor_user_id = (select auth.uid()));

-- No update / delete policies — the audit trail is append-only.
