-- Dialer pacing: space a campaign's cold dials out instead of firing the whole
-- concurrency allotment at once. Adds a per-campaign `dial_interval_seconds`
-- (0 = no pacing, today's behavior) and a backstop in pre_call_check that
-- blocks a cold dial when another cold call for the campaign was placed within
-- that interval. The dialer tick ALSO staggers placements; this is the safety
-- net so overlapping ticks can never land two calls closer than the interval.
alter table public.campaigns
  add column if not exists dial_interval_seconds integer not null default 0;

-- Re-declare pre_call_check (from 20260619140000) verbatim, adding ONE new
-- block: the pacing backstop inside the cold-outreach section. Scheduled
-- callbacks still bypass it (agreed appointments fire immediately).
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

  -- Pacing + hourly/daily call-VOLUME caps pace cold outreach only. A scheduled
  -- callback is an agreed appointment, so it bypasses these throttles.
  if v_lead.status <> 'callback' then
    -- Pacing: keep cold dials at least dial_interval_seconds apart so the
    -- campaign doesn't fire its whole concurrency allotment at once. 0 disables.
    if v_campaign.dial_interval_seconds > 0 and exists (
      select 1 from public.calls
       where campaign_id = in_campaign_id
         and direction = 'outbound'
         and call_mode = 'ai'
         and status <> 'failed'
         and created_at
             > now() - make_interval(secs => v_campaign.dial_interval_seconds)
    ) then
      return 'pacing_wait';
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
  end if;

  -- Concurrency (real-time safety) and spend caps (hard budget) STILL apply to
  -- callbacks.
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
       and created_at >= (
         date_trunc('day', now() at time zone 'America/New_York')
           at time zone 'America/New_York'
       );
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
       and created_at >= (
         date_trunc('month', now() at time zone 'America/New_York')
           at time zone 'America/New_York'
       );
    if v_spend_month >= v_campaign.monthly_spend_cap then
      return 'monthly_spend_cap_hit';
    end if;
  end if;

  return null;
end;
$$;

comment on function public.pre_call_check is
  'Final verification before firing a call. Returns null when safe to dial; '
  'otherwise a short reason string. Scheduled callbacks bypass the campaign '
  'calling window (kept inside an 08:00-21:00 local floor), the pacing interval, '
  'AND the hourly/daily call-volume caps, since they are agreed appointments; '
  'concurrency + spend caps and the in-flight guard still apply to them. '
  'Cold/retry leads are paced by dial_interval_seconds. Spend-cap windows are '
  'bound to the America/New_York calendar.';
