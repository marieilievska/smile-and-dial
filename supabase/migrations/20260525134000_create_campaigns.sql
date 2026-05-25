-- Campaigns: the unit that ties together a list of leads, an agent, a goal,
-- and a Twilio number. See BUILD_PLAN.md Section 3 (campaigns) and 5.5.

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'active'
    check (status in ('active', 'paused', 'ended')),
  agent_id uuid not null references public.agents (id) on delete restrict,
  twilio_number_id uuid
    references public.twilio_numbers (id) on delete set null,
  goal_id uuid not null references public.goals (id) on delete restrict,
  -- email_templates and calendly_events tables arrive in Phase 8.
  email_template_id uuid,
  calendly_event_id uuid,
  transfer_destination_phone text,
  calling_hours_start time not null default '09:00',
  calling_hours_end time not null default '21:00',
  calls_per_hour_cap integer not null default 30,
  calls_per_day_cap integer not null default 300,
  concurrency_cap_per_user integer not null default 2
    check (concurrency_cap_per_user between 1 and 5),
  daily_spend_cap numeric,
  monthly_spend_cap numeric,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);

comment on table public.campaigns is 'Calling campaigns — the unit that runs the dialer.';

create index campaigns_owner_id_idx on public.campaigns (owner_id);
create index campaigns_status_idx on public.campaigns (status);

-- Close the loop on the twilio_numbers.attached_campaign_id reference.
alter table public.twilio_numbers
  add constraint twilio_numbers_attached_campaign_fk
  foreign key (attached_campaign_id)
  references public.campaigns (id)
  on delete set null;

-- ---------------------------------------------------------------------------
-- Row-Level Security: campaigns are admin-managed (like agents).
-- ---------------------------------------------------------------------------
alter table public.campaigns enable row level security;

create policy "campaigns_select"
  on public.campaigns
  for select
  to authenticated
  using (public.is_admin((select auth.uid())));

create policy "campaigns_insert"
  on public.campaigns
  for insert
  to authenticated
  with check (public.is_admin((select auth.uid())));

create policy "campaigns_update"
  on public.campaigns
  for update
  to authenticated
  using (public.is_admin((select auth.uid())))
  with check (public.is_admin((select auth.uid())));

create policy "campaigns_delete"
  on public.campaigns
  for delete
  to authenticated
  using (public.is_admin((select auth.uid())));
