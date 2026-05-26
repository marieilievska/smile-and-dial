-- Calendly integration (Step 37 / BUILD_PLAN §11).
--
-- Workspace-wide OAuth connection (single row keyed off app_settings) plus a
-- per-event log of invitee.created / invitee.canceled / invitee.no_show
-- webhooks. In mock mode (CALENDLY_LIVE != "live") we simulate a connection
-- by stamping `connected_at`; live mode will populate `access_token` and
-- `refresh_token` via OAuth.

alter table public.app_settings
  add column if not exists calendly_access_token text,
  add column if not exists calendly_refresh_token text,
  add column if not exists calendly_organization_uri text,
  add column if not exists calendly_user_uri text,
  add column if not exists calendly_connected_at timestamptz,
  add column if not exists calendly_last_sync_at timestamptz;

-- Cached list of event types pulled from Calendly. Surfaced in the
-- campaign-settings dropdown (BUILD_PLAN §5.5).
create table if not exists public.calendly_event_types (
  id uuid primary key default gen_random_uuid(),
  event_uri text not null unique,
  name text not null,
  scheduling_url text,
  duration_minutes integer,
  active boolean not null default true,
  synced_at timestamptz not null default now()
);

alter table public.calendly_event_types enable row level security;

create policy "calendly_event_types_select"
  on public.calendly_event_types
  for select
  to authenticated
  using (true);

create policy "calendly_event_types_admin_write"
  on public.calendly_event_types
  for all
  to authenticated
  using (public.is_admin((select auth.uid())))
  with check (public.is_admin((select auth.uid())));

-- Per-invitee records. We never mutate the original Calendly payload; instead
-- we copy the fields the Goals page needs.
create table if not exists public.calendly_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  lead_id uuid references public.leads (id) on delete set null,
  invitee_uri text not null unique,
  event_uri text not null,
  event_type_uri text,
  invitee_email text,
  invitee_phone text,
  invitee_name text,
  scheduled_at timestamptz,
  reschedule_url text,
  cancel_url text,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'canceled', 'no_show')),
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists calendly_events_owner_id_idx
  on public.calendly_events (owner_id);
create index if not exists calendly_events_lead_id_idx
  on public.calendly_events (lead_id);
create index if not exists calendly_events_invitee_email_idx
  on public.calendly_events (lower(invitee_email));

alter table public.calendly_events enable row level security;

create policy "calendly_events_select"
  on public.calendly_events
  for select
  to authenticated
  using (
    owner_id = (select auth.uid())
    or public.is_admin((select auth.uid()))
  );

create policy "calendly_events_admin_write"
  on public.calendly_events
  for all
  to authenticated
  using (public.is_admin((select auth.uid())))
  with check (public.is_admin((select auth.uid())));

-- Add `scheduled` to the existing lead goal pipeline. We previously held
-- {goal_met, attended, no_show, sale, closed}; BUILD_PLAN §5.4 specifies
-- `scheduled` as the auto-set state when a Calendly invitee.created lands.
-- The leads.status column already exists; we just allow the new value.
alter table public.leads
  drop constraint if exists leads_status_check;

alter table public.leads
  add constraint leads_status_check check (
    status in (
      'ready_to_call', 'callback', 'resting', 'goal_met', 'scheduled',
      'attended', 'no_show', 'closed', 'sale', 'dnc', 'email_replied'
    )
  );

-- Convenience: stash the latest Calendly link on the lead for the
-- detail-modal "Calendly" pill (BUILD_PLAN §5.4 mentions a `calendly link`
-- on the goal pipeline row).
alter table public.leads
  add column if not exists calendly_event_uri text;
