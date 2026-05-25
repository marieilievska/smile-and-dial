-- The calls table, the dial_queue view, and pre-call check helpers.
-- See BUILD_PLAN.md Section 3 (calls), Section 11 (outbound dial loop).
--
-- This migration is DB-only. The cron Edge Function that reads the queue
-- and actually places calls lands in Step 21b — nothing here calls Twilio
-- or ElevenLabs.

-- ---------------------------------------------------------------------------
-- calls
-- ---------------------------------------------------------------------------
create table public.calls (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete restrict,
  campaign_id uuid not null references public.campaigns (id) on delete restrict,
  agent_id uuid references public.agents (id) on delete set null,
  twilio_number_id uuid references public.twilio_numbers (id) on delete set null,
  direction text not null check (direction in ('inbound', 'outbound')),
  status text not null default 'queued' check (
    status in (
      'queued', 'dialing', 'ringing', 'in_progress',
      'completed', 'failed', 'cancelled'
    )
  ),
  outcome text check (
    outcome is null
    or outcome in (
      'voicemail', 'no_answer', 'busy', 'failed', 'hung_up_immediately',
      'invalid_number', 'gatekeeper', 'not_interested', 'callback', 'dnc',
      'goal_met', 'language_barrier', 'ai_receptionist', 'ai_error',
      'transferred_to_human'
    )
  ),
  outcome_source text check (
    outcome_source is null
    or outcome_source in ('twilio', 'elevenlabs', 'manual')
  ),
  goal_met boolean not null default false,
  started_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  talk_time_seconds integer,
  recording_path text,
  transcript_json jsonb,
  summary text,
  score numeric,
  extracted_data jsonb,
  twilio_call_sid text unique,
  elevenlabs_conversation_id text unique,
  cost_breakdown jsonb,
  created_at timestamptz not null default now()
);

comment on table public.calls is 'One row per outbound or inbound call.';

create index calls_lead_id_idx on public.calls (lead_id);
create index calls_campaign_id_idx on public.calls (campaign_id);
create index calls_status_idx on public.calls (status);
create index calls_created_at_idx on public.calls (created_at desc);

-- The dnc_entries.source_call_id FK gets wired up now that calls exists.
alter table public.dnc_entries
  add constraint dnc_entries_source_call_id_fkey
    foreign key (source_call_id)
    references public.calls (id)
    on delete set null;

-- ---------------------------------------------------------------------------
-- Row-Level Security on calls
-- ---------------------------------------------------------------------------
alter table public.calls enable row level security;

-- A member sees calls for leads they own; admins see everything.
create policy "calls_select"
  on public.calls
  for select
  to authenticated
  using (
    public.is_admin((select auth.uid()))
    or exists (
      select 1 from public.leads l
      where l.id = calls.lead_id
        and l.owner_id = (select auth.uid())
    )
  );

-- Insert/update for now go through server actions running as the lead's
-- owner. We mirror the select policy: a member can only insert a call row
-- for a lead they own.
create policy "calls_insert"
  on public.calls
  for insert
  to authenticated
  with check (
    public.is_admin((select auth.uid()))
    or exists (
      select 1 from public.leads l
      where l.id = lead_id
        and l.owner_id = (select auth.uid())
    )
  );

create policy "calls_update"
  on public.calls
  for update
  to authenticated
  using (
    public.is_admin((select auth.uid()))
    or exists (
      select 1 from public.leads l
      where l.id = calls.lead_id
        and l.owner_id = (select auth.uid())
    )
  )
  with check (
    public.is_admin((select auth.uid()))
    or exists (
      select 1 from public.leads l
      where l.id = calls.lead_id
        and l.owner_id = (select auth.uid())
    )
  );

-- No delete policy — calls are immutable audit history.

-- ---------------------------------------------------------------------------
-- Helper: is the LEAD's local clock currently inside the campaign window?
-- ---------------------------------------------------------------------------
create or replace function public.is_within_calling_hours(
  lead_timezone text,
  hours_start time,
  hours_end time
)
returns boolean
language sql
stable
as $$
  select (
    now() at time zone coalesce(lead_timezone, 'America/New_York')
  )::time between hours_start and hours_end;
$$;

comment on function public.is_within_calling_hours is
  'True when the lead''s local time-of-day falls inside the campaign''s '
  'calling hours window. Defaults to America/New_York if the lead has no '
  'timezone set.';

-- ---------------------------------------------------------------------------
-- The dial queue.
--
-- A row appears here when a lead is genuinely a candidate for the next
-- outbound dial: ready by status, due by next_call_at, not on DNC, has a
-- phone, belongs to a list that's actively attached to an active campaign
-- with a Twilio number attached, and the lead's local clock is inside the
-- campaign's calling hours.
--
-- Cap, spend, and concurrency checks aren't in the view because they need
-- to be re-checked at dial time anyway — the cron does those in code and
-- bumps next_call_at when a cap blocks a candidate.
-- ---------------------------------------------------------------------------
create or replace view public.dial_queue
with (security_invoker = true)
as
select
  l.id as lead_id,
  l.owner_id,
  l.business_phone,
  l.timezone as lead_timezone,
  l.next_call_at,
  c.id as campaign_id,
  c.agent_id,
  c.twilio_number_id,
  c.calling_hours_start,
  c.calling_hours_end,
  c.calls_per_hour_cap,
  c.calls_per_day_cap,
  c.concurrency_cap_per_user,
  c.daily_spend_cap,
  c.monthly_spend_cap
from public.leads l
join public.list_campaign_attachments lca
  on lca.list_id = l.list_id and lca.detached_at is null
join public.campaigns c
  on c.id = lca.campaign_id and c.status = 'active'
where
  l.deleted_at is null
  and l.business_phone is not null
  and l.status in ('ready_to_call', 'callback')
  and (l.next_call_at is null or l.next_call_at <= now())
  and c.twilio_number_id is not null
  and not exists (
    select 1 from public.dnc_entries d
    where d.phone = l.business_phone
  )
  and public.is_within_calling_hours(
    l.timezone, c.calling_hours_start, c.calling_hours_end
  );

comment on view public.dial_queue is
  'Leads currently eligible to dial: ready, due, not on DNC, attached to an '
  'active campaign, inside calling hours. Re-check caps in code at dial '
  'time before actually firing the call.';

grant select on public.dial_queue to authenticated;

-- ---------------------------------------------------------------------------
-- Pre-call check.
--
-- The cron picks rows out of dial_queue and, just before firing the actual
-- Twilio call, calls this function as a final verification. Returns null
-- when it's safe to dial; otherwise returns a short reason string.
-- ---------------------------------------------------------------------------
create or replace function public.pre_call_check(
  in_lead_id uuid,
  in_campaign_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_lead public.leads%rowtype;
  v_campaign public.campaigns%rowtype;
  v_twilio public.twilio_numbers%rowtype;
  v_calls_last_hour integer;
  v_calls_last_day integer;
  v_active_calls integer;
  v_spend_today numeric;
  v_spend_month numeric;
begin
  select * into v_lead from public.leads where id = in_lead_id;
  if not found or v_lead.deleted_at is not null then
    return 'lead_missing_or_deleted';
  end if;
  if v_lead.business_phone is null then
    return 'lead_has_no_phone';
  end if;

  if exists (
    select 1 from public.dnc_entries where phone = v_lead.business_phone
  ) then
    return 'lead_on_dnc';
  end if;

  select * into v_campaign from public.campaigns where id = in_campaign_id;
  if not found or v_campaign.status <> 'active' then
    return 'campaign_not_active';
  end if;

  if v_campaign.twilio_number_id is null then
    return 'campaign_has_no_twilio_number';
  end if;

  select * into v_twilio
    from public.twilio_numbers
   where id = v_campaign.twilio_number_id;
  if not found then
    return 'twilio_number_missing';
  end if;
  if v_twilio.attached_campaign_id is distinct from in_campaign_id then
    return 'twilio_number_reassigned';
  end if;

  if not public.is_within_calling_hours(
    v_lead.timezone,
    v_campaign.calling_hours_start,
    v_campaign.calling_hours_end
  ) then
    return 'outside_calling_hours';
  end if;

  -- Hourly cap (rolling 60 min).
  select count(*) into v_calls_last_hour
    from public.calls
   where campaign_id = in_campaign_id
     and direction = 'outbound'
     and created_at >= now() - interval '1 hour';
  if v_calls_last_hour >= v_campaign.calls_per_hour_cap then
    return 'hourly_cap_hit';
  end if;

  -- Daily cap (rolling 24 hr).
  select count(*) into v_calls_last_day
    from public.calls
   where campaign_id = in_campaign_id
     and direction = 'outbound'
     and created_at >= now() - interval '24 hours';
  if v_calls_last_day >= v_campaign.calls_per_day_cap then
    return 'daily_cap_hit';
  end if;

  -- Owner concurrency cap (calls still in flight for any campaign).
  select count(*) into v_active_calls
    from public.calls c
    join public.leads l on l.id = c.lead_id
   where l.owner_id = v_lead.owner_id
     and c.status in ('queued', 'dialing', 'ringing', 'in_progress');
  if v_active_calls >= v_campaign.concurrency_cap_per_user then
    return 'concurrency_cap_hit';
  end if;

  -- Spend caps (today and this calendar month, summed from cost_breakdown).
  if v_campaign.daily_spend_cap is not null then
    select coalesce(sum((cost_breakdown->>'total')::numeric), 0)
      into v_spend_today
      from public.calls
     where campaign_id = in_campaign_id
       and created_at >= date_trunc('day', now());
    if v_spend_today >= v_campaign.daily_spend_cap then
      return 'daily_spend_cap_hit';
    end if;
  end if;

  if v_campaign.monthly_spend_cap is not null then
    select coalesce(sum((cost_breakdown->>'total')::numeric), 0)
      into v_spend_month
      from public.calls
     where campaign_id = in_campaign_id
       and created_at >= date_trunc('month', now());
    if v_spend_month >= v_campaign.monthly_spend_cap then
      return 'monthly_spend_cap_hit';
    end if;
  end if;

  return null;
end;
$$;

comment on function public.pre_call_check is
  'Final verification before firing a call. Returns null when safe to dial; '
  'otherwise returns a short reason string the caller can log and use to '
  'decide how to reschedule next_call_at.';

grant execute on function public.pre_call_check(uuid, uuid) to authenticated;
