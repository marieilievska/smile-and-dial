-- ---------------------------------------------------------------------------
-- Live-mode dialer correctness fixes (audit follow-up).
--
-- Two bugs in the original dial-time gating, both only bite once real
-- calling is switched on:
--
--  1. is_within_calling_hours used SQL `BETWEEN`, which is false whenever
--     the window wraps past midnight (start > end, e.g. 21:00–06:00). An
--     admin who sets an evening window gets a campaign that silently never
--     dials. Fix: handle the wrap-around case explicitly.
--
--  2. The spend caps in pre_call_check summed cost_breakdown->>'total', but
--     a call's cost is only written AFTER it ends. Queued/dialing/ringing/
--     in_progress calls therefore contributed $0, so a burst of ticks could
--     each pass the cap while many in-flight calls had real (uncounted)
--     cost — overshooting the daily/monthly cap. Fix: add a conservative
--     reserved estimate for each in-flight call to the summed actuals.
-- ---------------------------------------------------------------------------

-- Conservative per-call cost reservation for calls that haven't billed yet.
-- Matches the mock cost model's order of magnitude (~$0.07/call) rounded up
-- so the cap errs toward stopping early rather than overshooting.
create or replace function public.is_within_calling_hours(
  lead_timezone text,
  hours_start time,
  hours_end time
)
returns boolean
language sql
stable
as $$
  with t as (
    select (
      now() at time zone coalesce(lead_timezone, 'America/New_York')
    )::time as local_now
  )
  select case
    -- Normal, same-day window (e.g. 09:00–21:00).
    when hours_start <= hours_end
      then (select local_now from t) between hours_start and hours_end
    -- Wrap-around window past midnight (e.g. 21:00–06:00): inside if the
    -- local time is at/after the start OR at/before the end.
    else (select local_now from t) >= hours_start
      or (select local_now from t) <= hours_end
  end;
$$;

comment on function public.is_within_calling_hours is
  'True when the lead''s local time-of-day falls inside the campaign''s '
  'calling hours window. Handles windows that wrap past midnight '
  '(start > end). Defaults to America/New_York if the lead has no timezone.';

-- ---------------------------------------------------------------------------
-- pre_call_check, with spend caps that also reserve cost for in-flight calls.
-- Everything else in the function is unchanged from the original.
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
  'otherwise a short reason string. Spend caps reserve a conservative cost '
  'for in-flight calls that have not billed yet so concurrent dials cannot '
  'collectively overshoot the cap.';
