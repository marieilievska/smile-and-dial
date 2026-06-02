-- Per-user Close + Calendly credentials.
--
-- ElevenLabs / Twilio / OpenAI are ONE shared account behind the whole
-- product (configured via server env). Close and Calendly are different:
-- each rep connects their OWN account, and the AI books / emails on behalf of
-- the **campaign owner**. So their credentials move out of the global
-- app_settings row into a per-user table, resolved at tool time by the
-- owning user.
--
-- Tokens are pasted by the user (Calendly Personal Access Token, Close API
-- key) and stored here. The tool webhooks read them with the service role
-- (which bypasses RLS); the UI only ever sees the signed-in user's own row.

create table if not exists public.user_integrations (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- Calendly
  calendly_api_key text,
  calendly_organization_uri text,
  calendly_user_uri text,
  calendly_connected_at timestamptz,
  calendly_last_sync_at timestamptz,
  -- Close
  close_api_key text,
  close_connected_at timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.user_integrations is
  'Per-user Close + Calendly credentials. Resolved by campaign owner at tool '
  'time. ElevenLabs/Twilio/OpenAI stay global in server env.';

alter table public.user_integrations enable row level security;

-- A user manages only their own integration row.
create policy "user_integrations_select"
  on public.user_integrations
  for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy "user_integrations_insert"
  on public.user_integrations
  for insert
  to authenticated
  with check (user_id = (select auth.uid()));

create policy "user_integrations_update"
  on public.user_integrations
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Calendly event types become per-user: each user syncs their OWN meeting
-- types, and a campaign's dropdown shows the campaign owner's types.
-- ---------------------------------------------------------------------------
alter table public.calendly_event_types
  add column if not exists owner_id uuid references public.profiles (id) on delete cascade;

-- The event_uri was globally unique; make it unique PER owner instead so two
-- users can each have their own event types without collision.
alter table public.calendly_event_types
  drop constraint if exists calendly_event_types_event_uri_key;

create unique index if not exists calendly_event_types_owner_event_uri_key
  on public.calendly_event_types (owner_id, event_uri);

create index if not exists calendly_event_types_owner_id_idx
  on public.calendly_event_types (owner_id);

-- Scope reads to the owner (admins still see all). Replaces the prior
-- everyone-can-read policy now that types are per-user.
drop policy if exists "calendly_event_types_select"
  on public.calendly_event_types;

create policy "calendly_event_types_select"
  on public.calendly_event_types
  for select
  to authenticated
  using (
    owner_id = (select auth.uid())
    or public.is_admin((select auth.uid()))
  );

-- The old global mock rows (owner_id null) are now orphaned; drop them so
-- they don't linger in per-user dropdowns.
delete from public.calendly_event_types where owner_id is null;
