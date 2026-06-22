-- Per-day operator notes for the Market Research reporting dashboard. When a KPI
-- dips or spikes, an admin annotates that day ("changed the opening line") so the
-- movement has context next to the numbers. One note per Eastern calendar day
-- (matching the dashboard's day grain). Admin-managed; NOT shown on the public
-- share (these are internal ops notes).

create table public.dashboard_notes (
  day date primary key,
  note text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

comment on table public.dashboard_notes is
  'Per-day operator annotations for the reporting dashboard (why a KPI moved). '
  'One row per Eastern calendar day. Admin-managed; omitted from the public share.';

alter table public.dashboard_notes enable row level security;

create policy "dashboard_notes_admin_all" on public.dashboard_notes
  for all to authenticated
  using (public.is_admin((select auth.uid())))
  with check (public.is_admin((select auth.uid())));

grant select, insert, update, delete on public.dashboard_notes to authenticated;
