-- Restore the dialer rules lost by the number-pool rebuild, and set the
-- callback policy Marija specified.
--
-- WHAT HAPPENED: 20260718150100 / 20260718150200 re-created pre_call_check and
-- dial_queue from stale bases (2026-06-19 and 2026-06-11) to make one change
-- each (single-number -> pool). `create or replace` overwrites the whole
-- object, so every rule added to them between that base and 07-18 was silently
-- dropped: callbacks-when-autopilot-off, the mobile lock, the shared-list
-- ownership guard, audience/smart-list targeting, weekend callbacks, and cold
-- dial pacing. Nothing warned, nothing tested them, and no campaign was
-- auto-dialing, so it stayed invisible until an overdue callback was chased.
--
-- This rebuilds BOTH from the last-good definitions (20260717120000 for
-- dial_queue, 20260713120000 for pre_call_check) with ONLY the pool change
-- carried forward, plus the callback-policy decisions below.
--
-- CALLBACK POLICY (deliberate product decision, 2026-07-21 — do NOT "fix" this
-- back to a time window; it is not another accident):
--   * A scheduled callback runs whenever it is scheduled for. It ignores the
--     campaign's calling hours, runs on weekends, and has NO time-of-day floor
--     at all -- an agreed appointment is honoured at the agreed time.
--     Marija was shown the TCPA 8am-9pm trade-off explicitly and chose no floor.
--   * COLD outreach is unchanged: campaign calling hours, weekdays only.
--     The bypass keys on lead.status='callback', so it can never widen cold
--     dialling.

-- ---------------------------------------------------------------------------
-- 1. pre_call_check
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

comment on function public.pre_call_check(uuid, uuid) is
  'Returns null when (lead, campaign) is safe to AI-dial right now, otherwise a '
  'short reason string. Leads tagged line_type=''mobile'' are hard-blocked '
  '(human browser dialling bypasses this function by design). Scheduled '
  'callbacks ignore calling hours entirely and bypass pacing + volume caps; '
  'concurrency and spend caps always apply.';

-- ---------------------------------------------------------------------------
-- 2. dial_queue
-- ---------------------------------------------------------------------------
create or replace view public.dial_queue
with (security_invoker = true)
as
select
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
    -- Autopilot pauses COLD outreach only. A scheduled callback is a promise to
    -- a person, so it still runs with autopilot off.
    and (c.autopilot_enabled = true or l.status = 'callback')
    -- Shared lists: a lead belongs to the campaign that first dialled it, and
    -- no other campaign may touch it until that campaign releases it (which
    -- happens when the list is detached -- see list-attachments-actions.ts).
    and (l.owner_campaign_id is null or l.owner_campaign_id = c.id)
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
    -- Pool gate (the number itself is chosen at placement by selectPoolNumber).
    and exists (
      select 1 from public.twilio_numbers tn
       where tn.attached_campaign_id = c.id
         and tn.released_at is null
         and tn.pool_status = 'active'
         and tn.flagged_for_rotation = false
         and tn.elevenlabs_phone_number_id is not null
    )
    -- Never AI-dial a mobile (mirrors pre_call_check; human dialling bypasses).
    and l.line_type is distinct from 'mobile'
    and not exists (
      select 1 from public.dnc_entries d
      where d.phone = l.business_phone
    )
    -- Scheduled callbacks run whenever they were booked for -- no window, no
    -- weekday gate. Cold outreach: campaign hours, weekdays only.
    and (
      l.status = 'callback'
      or public.is_within_calling_hours(
        l.timezone, c.calling_hours_start, c.calling_hours_end, false
      )
    )
) q
order by q.dial_priority, q.next_call_at nulls first;

comment on view public.dial_queue is
  'Leads eligible for the AUTO-dialer: ready, due, not on DNC, not a mobile, '
  'owned by this campaign (or unowned), targeted by an attached list / audience '
  'search / smart list, on an active campaign with >=1 usable pool number. '
  'Autopilot gates COLD leads only -- scheduled callbacks run regardless, at '
  'whatever time they were booked for. dial_priority orders callbacks (0) ahead '
  'of cold leads (1). The specific number is chosen at placement by '
  'selectPoolNumber. Re-check caps in code.';

grant select on public.dial_queue to authenticated;
