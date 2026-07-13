-- Import mobiles into a separate list + hard "never auto-dial mobiles" lock.
--
-- 1) leads.line_type: Twilio Lookup classification captured at import. NULL for
--    every existing lead and for lookup-skipped imports, so nothing that exists
--    today changes behavior.
-- 2) pre_call_check: hard-block any lead tagged 'mobile' (covers BOTH the
--    Autopilot cron and manual Call Now -- they share this gate).
-- 3) dial_queue: also filter mobiles out of the candidate list (defense in
--    depth; `is distinct from` keeps NULL = dialable).

alter table public.leads
  add column if not exists line_type text;

comment on column public.leads.line_type is
  'Twilio Lookup line-type at import (landline|mobile|voip|invalid|unknown). '
  'NULL for pre-feature or lookup-skipped leads. Leads tagged ''mobile'' are '
  'never auto-dialed (enforced in pre_call_check and dial_queue).';

-- dial_queue: re-declared verbatim from 20260705120000, adding ONLY the
-- line_type filter so mobiles never enter the candidate queue.
create or replace view public.dial_queue
with (security_invoker = true)
as
select distinct on (q.lead_id)
  q.lead_id,
  q.owner_id,
  q.business_phone,
  q.lead_timezone,
  q.next_call_at,
  q.campaign_id,
  q.agent_id,
  q.twilio_number_id,
  q.calling_hours_start,
  q.calling_hours_end,
  q.calls_per_hour_cap,
  q.calls_per_day_cap,
  q.concurrency_cap_per_user,
  q.daily_spend_cap,
  q.monthly_spend_cap,
  q.dial_priority
from (
  select
    l.id as lead_id,
    l.owner_id,
    l.business_phone,
    l.timezone as lead_timezone,
    l.next_call_at,
    c.id as campaign_id,
    c.created_at as campaign_created_at,
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
  join public.campaigns c
    on c.owner_id = l.owner_id
    and c.status = 'active'
    and (c.autopilot_enabled = true or l.status = 'callback')
    and (
      exists (
        select 1 from public.list_campaign_attachments lca
        where lca.campaign_id = c.id
          and lca.list_id = l.list_id
          and lca.detached_at is null
      )
      or (
        c.audience_search is not null
        and l.company is not null
        and l.company ilike '%' || c.audience_search || '%'
      )
      or (
        c.smart_list_id is not null
        and exists (
          select 1 from public.smart_list_members slm
          where slm.smart_list_id = c.smart_list_id
            and slm.lead_id = l.id
        )
      )
    )
  where
    l.deleted_at is null
    and l.business_phone is not null
    and l.status in ('ready_to_call', 'callback')
    and (l.next_call_at is null or l.next_call_at <= now())
    and c.twilio_number_id is not null
    and l.line_type is distinct from 'mobile'
    and not exists (
      select 1 from public.dnc_entries d
      where d.phone = l.business_phone
    )
    and (
      case
        when l.status = 'callback' then public.is_within_calling_hours(
          l.timezone, time '08:00:00', time '21:00:00', true
        )
        else public.is_within_calling_hours(
          l.timezone, c.calling_hours_start, c.calling_hours_end, false
        )
      end
    )
) q
order by q.lead_id, q.dial_priority, q.campaign_created_at, q.campaign_id;

-- pre_call_check: re-declared verbatim from 20260705120000, adding ONLY the
-- mobile guard right after the DNC check.
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

  -- Never auto-dial a mobile. Smile & Dial uses an AI (artificial) voice;
  -- auto-dialing cell phones is TCPA-restricted, so mobiles imported for manual
  -- handling are hard-blocked here. NULL line_type (older leads, or lookup
  -- skipped) is NOT blocked -- unchanged behavior.
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
  -- campaign's narrower window but stays inside the 08:00-21:00 local floor, and
  -- may fall on a WEEKEND (agreed appointment); cold outreach is weekdays only.
  if not public.is_within_calling_hours(
    v_lead.timezone,
    case when v_lead.status = 'callback'
      then time '08:00:00' else v_campaign.calling_hours_start end,
    case when v_lead.status = 'callback'
      then time '21:00:00' else v_campaign.calling_hours_end end,
    v_lead.status = 'callback'
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
  'otherwise a short reason string. Leads tagged line_type=''mobile'' are hard-'
  'blocked (lead_is_mobile) so the AI never auto-dials a cell phone. Scheduled '
  'callbacks bypass the campaign calling window (kept inside an 08:00-21:00 '
  'local floor), MAY dial on weekends, and bypass the pacing interval + '
  'hourly/daily volume caps, since they are agreed appointments; concurrency + '
  'spend caps and the in-flight guard still apply to them. Cold/retry leads are '
  'weekday-only and paced by dial_interval_seconds. Spend-cap windows are bound '
  'to America/New_York.';
