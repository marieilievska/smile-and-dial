-- ---------------------------------------------------------------------------
-- pre_call_check: per-lead in-flight guard + AI-only cap counting.
--
-- This re-declares pre_call_check identically to the previous version
-- (20260601120000) EXCEPT for three changes; everything else — parameters,
-- return type, DNC check, campaign-active/attachment check, twilio-number
-- check, calling-hours check, spend caps, and the final NULL ('ok') return —
-- is byte-for-byte equivalent.
--
--  (1) PER-LEAD IN-FLIGHT GUARD (closes double-dial races: #4 / #21 /
--      Call-Now). New 'call_in_flight' check, placed right after the
--      DNC/lead-exists checks and before the cap checks. Returns
--      'call_in_flight' when the lead already has a call currently in flight
--      (status in queued/dialing/ringing/in_progress) created within the last
--      15 minutes. The 15-minute window matches the stale-call reaper
--      (closeStaleActiveCalls / STALE_MINUTES = 15): the reaper flips dead
--      in-flight rows to 'failed' at 15 min, so a crashed/stale dialing row
--      can't block the lead forever. This stops the autopilot tick from
--      AI-dialing a business while a human browser call (or Call Now, or
--      another tick) is already on the line with that same business.
--
--  (2) HOURLY + DAILY CAP COUNTING — count only AI auto-dial placements.
--      The previous caps counted ALL outbound rows regardless of call_mode
--      and status, so (a) human browser calls (call_mode='human') ate the AI
--      campaign's budget and (b) failed placements polluted it. Both the
--      hourly and daily COUNT queries now additionally require
--      call_mode='ai' AND status <> 'failed'. The time windows and cap
--      values are unchanged. (call_mode exists on calls, default 'ai', as of
--      migration 20260612090000.)
--
--  (3) CONCURRENCY CAP — UNCHANGED. It still counts ALL in-flight calls
--      regardless of call_mode, on purpose: a human call SHOULD count against
--      the owner's concurrency so the AI and the rep don't both blast the
--      same owner's lines at once.
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
  -- Conservative reservation per not-yet-billed in-flight call.
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

  -- CHANGE (1): per-lead in-flight guard. Block dialing a lead that already
  -- has a call in flight (any mode) within the stale-call reaper's 15-minute
  -- window, so we never start a second call to the same business while a
  -- human browser call / Call Now / another tick is already on the line.
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

  if not public.is_within_calling_hours(
    v_lead.timezone,
    v_campaign.calling_hours_start,
    v_campaign.calling_hours_end
  ) then
    return 'outside_calling_hours';
  end if;

  -- Hourly cap (rolling 60 min). CHANGE (2): count only AI auto-dial
  -- placements that didn't fail — human calls and failed rows don't count.
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

  -- Daily cap (rolling 24 hr). CHANGE (2): count only AI auto-dial
  -- placements that didn't fail — human calls and failed rows don't count.
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

  -- Owner concurrency cap (calls still in flight for any campaign).
  -- CHANGE (3): UNCHANGED — counts all in-flight calls regardless of
  -- call_mode so a human call still counts against the owner's concurrency.
  select count(*) into v_active_calls
    from public.calls c
    join public.leads l on l.id = c.lead_id
   where l.owner_id = v_lead.owner_id
     and c.status in ('queued', 'dialing', 'ringing', 'in_progress');
  if v_active_calls >= v_campaign.concurrency_cap_per_user then
    return 'concurrency_cap_hit';
  end if;

  -- Spend caps. Sum the actual billed cost PLUS a conservative reservation
  -- for each in-flight call in the same window whose cost hasn't landed yet.
  -- Without the reservation, a burst of concurrent dials each see $0 for the
  -- others and collectively blow past the cap.
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
  'otherwise a short reason string. Blocks a lead that already has a call in '
  'flight (call_in_flight, 15-min window matching the stale-call reaper). '
  'Hourly/daily caps count only AI auto-dial placements (call_mode=ai, '
  'non-failed); concurrency counts all in-flight calls. Spend caps reserve a '
  'conservative cost for in-flight calls that have not billed yet so '
  'concurrent dials cannot collectively overshoot the cap.';
