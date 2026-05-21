-- Twilio numbers: a workspace-wide pool of phone numbers used for calling.
-- See BUILD_PLAN.md Section 3 (twilio_numbers) and Section 10.

create table public.twilio_numbers (
  id uuid primary key default gen_random_uuid(),
  phone_number text not null unique,
  friendly_name text,
  country text not null check (country in ('US', 'CA')),
  monthly_cost numeric not null default 0,
  -- Twilio's IncomingPhoneNumber SID; null for mock numbers.
  twilio_sid text,
  -- FK to campaigns is added in the campaigns migration (Step 18).
  attached_campaign_id uuid,
  purchased_at timestamptz not null default now(),
  released_at timestamptz,
  -- Connect-rate tracking, populated by the Phase 4 rotation monitor.
  last_connect_rate_check_at timestamptz,
  last_calls_count_24h integer not null default 0,
  last_connect_rate_24h numeric,
  flagged_for_rotation boolean not null default false
);

comment on table public.twilio_numbers is 'Workspace pool of Twilio phone numbers.';

-- ---------------------------------------------------------------------------
-- Row-Level Security: Twilio numbers are managed by admins only.
-- ---------------------------------------------------------------------------
alter table public.twilio_numbers enable row level security;

create policy "twilio_numbers_select"
  on public.twilio_numbers
  for select
  to authenticated
  using (public.is_admin((select auth.uid())));

create policy "twilio_numbers_insert"
  on public.twilio_numbers
  for insert
  to authenticated
  with check (public.is_admin((select auth.uid())));

create policy "twilio_numbers_update"
  on public.twilio_numbers
  for update
  to authenticated
  using (public.is_admin((select auth.uid())))
  with check (public.is_admin((select auth.uid())));

create policy "twilio_numbers_delete"
  on public.twilio_numbers
  for delete
  to authenticated
  using (public.is_admin((select auth.uid())));
