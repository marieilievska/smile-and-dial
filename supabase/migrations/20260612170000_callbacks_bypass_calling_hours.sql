-- Scheduled callbacks may be dialed outside the campaign's calling window.
--
-- A callback is a time the prospect specifically agreed to be called, so the
-- campaign's narrower business window (e.g. 09:00-17:00) should not block it.
-- We still keep a hard legal-safety floor of 08:00-21:00 local (the standard
-- telemarketing window) so a mis-scheduled callback can never dial in the
-- middle of the night.
--
-- Two enforcement points, both updated:
--   1. dial_queue view  — the AUTO-dialer's eligibility list.
--   2. pre_call_check()  — the final gate (auto-dial AND Call Now).
-- Non-callback leads (status='ready_to_call') are unchanged.

-- ---------------------------------------------------------------------------
-- 1. dial_queue: callbacks use the 08:00-21:00 floor; others the campaign window.
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
  c.monthly_spend_cap,
  (case when l.status = 'callback' then 0 else 1 end) as dial_priority
from public.leads l
join public.list_campaign_attachments lca
  on lca.list_id = l.list_id and lca.detached_at is null
join public.campaigns c
  on c.id = lca.campaign_id
  and c.status = 'active'
  and c.autopilot_enabled = true
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
  and (
    case
      when l.status = 'callback' then public.is_within_calling_hours(
        l.timezone, time '08:00:00', time '21:00:00'
      )
      else public.is_within_calling_hours(
        l.timezone, c.calling_hours_start, c.calling_hours_end
      )
    end
  );

comment on view public.dial_queue is
  'Leads currently eligible for the AUTO-dialer: ready, due, not on DNC, '
  'attached to an active campaign with autopilot on. Inside the campaign '
  'calling window for cold/retry leads; inside the 08:00-21:00 local legal '
  'floor for scheduled callbacks (an agreed time overrides the narrower '
  'window). dial_priority orders callbacks (0) ahead of cold leads (1).';

grant select on public.dial_queue to authenticated;

-- ---------------------------------------------------------------------------
-- 2. pre_call_check: same callback exemption. Re-declared identically to
--    20260612110000 EXCEPT the calling-hours block (callbacks → 08:00-21:00).
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
  v_reserve_per_call constant numeric := 0.10;
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

  if exists (
    select 1 from public.calls
     where lead_id = in_lead_id
       and status in ('queued', 'dialing', 'ringing', 'in_progress')
       and created_at > now() - interval '15 minutes'
  ) then
    return 'call_in_flight';
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

  -- Calling hours. A scheduled callback (lead.status='callback') overrides the
  -- campaign's narrower window but stays inside the 08:00-21:00 local legal
  -- floor; everything else uses the campaign window.
  if not public.is_within_calling_hours(
    v_lead.timezone,
    case when v_lead.status = 'callback'
      then time '08:00:00' else v_campaign.calling_hours_start end,
    case when v_lead.status = 'callback'
      then time '21:00:00' else v_campaign.calling_hours_end end
  ) then
    return 'outside_calling_hours';
  end if;

  select count(*) into v_calls_last_hour
    from public.calls
   where campaign_id = in_campaign_id
     and direction = 'outbound'
     and call_mode = 'ai'
     and status <> 'failed'
     and created_at >= now() - interval '1 hour';
  if v_calls_last_hour >= v_campaign.calls_per_hour_cap then
    return 'hourly_cap_hit';
  end if;

  select count(*) into v_calls_last_day
    from public.calls
   where campaign_id = in_campaign_id
     and direction = 'outbound'
     and call_mode = 'ai'
     and status <> 'failed'
     and created_at >= now() - interval '24 hours';
  if v_calls_last_day >= v_campaign.calls_per_day_cap then
    return 'daily_cap_hit';
  end if;

  select count(*) into v_active_calls
    from public.calls c
    join public.leads l on l.id = c.lead_id
   where l.owner_id = v_lead.owner_id
     and c.status in ('queued', 'dialing', 'ringing', 'in_progress');
  if v_active_calls >= v_campaign.concurrency_cap_per_user then
    return 'concurrency_cap_hit';
  end if;

  if v_campaign.daily_spend_cap is not null then
    select
      coalesce(sum((cost_breakdown->>'total')::numeric), 0)
      + (
        count(*) filter (
          where status in ('queued', 'dialing', 'ringing', 'in_progress')
            and (cost_breakdown->>'total') is null
        ) * v_reserve_per_call
      )
      into v_spend_today
      from public.calls
     where campaign_id = in_campaign_id
       and created_at >= date_trunc('day', now());
    if v_spend_today >= v_campaign.daily_spend_cap then
      return 'daily_spend_cap_hit';
    end if;
  end if;

  if v_campaign.monthly_spend_cap is not null then
    select
      coalesce(sum((cost_breakdown->>'total')::numeric), 0)
      + (
        count(*) filter (
          where status in ('queued', 'dialing', 'ringing', 'in_progress')
            and (cost_breakdown->>'total') is null
        ) * v_reserve_per_call
      )
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
  'otherwise a short reason string. Scheduled callbacks may dial outside the '
  'campaign window but stay inside the 08:00-21:00 local legal floor. Blocks a '
  'lead with a call in flight (call_in_flight, 15-min window). Hourly/daily '
  'caps count only AI auto-dial placements; concurrency counts all in-flight '
  'calls; spend caps reserve a conservative cost for unbilled in-flight calls.';
