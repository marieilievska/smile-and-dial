-- Daily call caps: switch from a rolling 24h window to an Eastern CALENDAR day,
-- matching the spend caps (which already use America/New_York) and the app's
-- ET-day convention. "300 calls per day" now means "300 per ET calendar day,
-- resetting at midnight ET" for BOTH the campaign calls_per_day_cap
-- (pre_call_check) and the per-number pool cap (pool_number_usage_24h) -- so
-- 3 numbers x 100 genuinely = 300 fresh every day. Safe: calling hours
-- (09:00-20:00) prevent any midnight-boundary burst. Hourly cap stays rolling
-- (it is a rate limiter, not a "daily" concept). No behaviour change beyond the
-- window; both functions are otherwise byte-identical to their prior definitions.
-- (pool_number_usage_24h keeps its name for the TS caller; it now counts the ET day.)

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

  -- Never AI-dial a mobile. Smile & Dial uses an artificial voice; auto-dialing
  -- cell phones is TCPA-restricted, so mobiles imported for manual handling are
  -- hard-blocked here. This covers both the autopilot tick and Call Now (both
  -- run pre_call_check); HUMAN browser dialling does not call this function, so
  -- a person can still ring a mobile by hand -- which is the intent. NULL
  -- line_type (older leads, or lookup skipped) is NOT blocked.
  if v_lead.line_type = 'mobile' then
    return 'lead_is_mobile';
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

  -- Pool gate: the campaign must have >=1 usable number. The SPECIFIC number is
  -- chosen at placement by selectPoolNumber (which also enforces per-number
  -- daily caps + rest windows); this only guards "any number available at all".
  if not exists (
    select 1 from public.twilio_numbers tn
     where tn.attached_campaign_id = in_campaign_id
       and tn.released_at is null
       and tn.pool_status = 'active'
       and tn.flagged_for_rotation = false
       and tn.elevenlabs_phone_number_id is not null
  ) then
    return 'campaign_has_no_numbers';
  end if;

  -- Calling hours. A scheduled callback runs at whatever time it was booked
  -- for -- no window, no weekday gate (see CALLBACK POLICY above). Cold
  -- outreach uses the campaign window, weekdays only.
  if v_lead.status <> 'callback'
     and not public.is_within_calling_hours(
       v_lead.timezone,
       v_campaign.calling_hours_start,
       v_campaign.calling_hours_end,
       false
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
       and created_at >= date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York';
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

comment on function public.pre_call_check(uuid, uuid) is
  'Returns null when (lead, campaign) is safe to AI-dial right now, otherwise a '
  'short reason string. Leads tagged line_type=''mobile'' are hard-blocked '
  '(human browser dialling bypasses this function by design). Scheduled '
  'callbacks ignore calling hours entirely and bypass pacing + volume caps; '
  'concurrency and spend caps always apply.';

create or replace function public.pool_number_usage_24h(in_campaign_id uuid)
returns table (twilio_number_id uuid, calls_24h bigint)
language sql
stable
security definer
set search_path = public
as $$
  select c.twilio_number_id, count(*)
    from public.calls c
   where c.campaign_id = in_campaign_id
     and c.direction = 'outbound'
     and c.call_mode = 'ai'
     and c.status <> 'failed'
     and c.twilio_number_id is not null
     and c.created_at >= date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York'
   group by c.twilio_number_id;
$$;

comment on function public.pool_number_usage_24h is
  'Per-number outbound-AI call count over the current Eastern day for a campaign''s '
  'pool, grouped in SQL to dodge the 1,000-row cap. Used by selectPoolNumber '
  'to enforce per-number daily caps.';
