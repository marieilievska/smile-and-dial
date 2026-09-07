-- Phase 3 of "Performance by lead list": the unit economics.
--
-- Adds the three columns the "Where the money goes" panel needs. Same function
-- again rather than a second one, so every panel on the page keeps sharing one
-- round trip and they cannot disagree about `leads` or `worked`.
--
-- DROP then CREATE, because a RETURNS TABLE signature cannot be widened with
-- CREATE OR REPLACE. Backwards compatible in the direction that matters: the
-- deployed page reads columns by name, so it keeps working against the wider
-- function until its own deploy lands.
--
-- ---------------------------------------------------------------------------
-- no_show / pending -- why a show rate cannot use `regs` as its denominator
--
-- `attended / regs` is wrong, and wrong in the same way `goals / leads` would
-- be: it divides by cases that have not happened yet. On 2026-09-07, 12 of 20
-- live registrations were for sessions still in the future, so the naive rate
-- read 20% when the true rate was 50%, and cost per attended read $187.00 when
-- it was $74.80.
--
-- These two definitions are COPIED VERBATIM from cohort_rows
-- (20260905130000_cohort_rows_fn.sql). They are not re-derived, because two
-- pages computing a show rate from the same table by different rules is a bug
-- nobody can see. tests/list-performance.unit.test.ts pins them character for
-- character against that file.
--
--   no_show  not cancelled, not marked attended, session started MORE than 24h
--            ago. The 24h grace is load-bearing: without it a session that
--            ended two hours ago is a no-show before anyone could mark it.
--   pending  not cancelled, not marked attended, session started LESS than 24h
--            ago or still to come.
--
-- settled = attended + no_show is derived in TypeScript, never stored.
--
-- ---------------------------------------------------------------------------
-- worked_7d -- pace, and why it ignores every filter
--
-- Distinct live leads dialled in the last 7 days. It backs the "Days left"
-- column: remaining / (worked_7d / pace_days).
--
-- It follows NEITHER the date pills NOR the campaign filter, exactly like
-- `remaining`, `bad_number` and the rest of the inventory block. Pace is a
-- property of now, not of the window you are looking through. A "Days left"
-- that changed when you moved the date pills would be worse than none at all.
drop function if exists public.list_performance(date, date, uuid, uuid);

create function public.list_performance(
  p_start date default null,
  p_end date default null,
  p_campaign uuid default null,
  p_owner uuid default null
)
returns table (
  list_id uuid,
  list_name text,
  is_inbound boolean,
  leads integer,
  worked integer,
  calls integer,
  connected integer,
  dms integer,
  goals integer,
  regs integer,
  attended integer,
  sales integer,
  spend numeric,
  first_call timestamptz,
  last_call timestamptz,
  reached integer,
  voicemail integer,
  line_typed integer,
  mobiles integer,
  bad_number integer,
  suppressed integer,
  resting integer,
  remaining integer,
  no_show integer,
  pending integer,
  worked_7d integer
)
language sql
stable
security invoker
set search_path = public
as $$
  with scoped_calls as (
    select
      le.list_id,
      c.lead_id,
      c.outcome,
      c.goal_met,
      le.decision_maker_reached,
      le.deleted_at,
      c.created_at,
      public.call_cost_total(c.cost_breakdown) as cost
    from calls c
    join leads le on le.id = c.lead_id
    where (
        p_start is null
        or (c.created_at at time zone 'America/New_York')::date >= p_start
      )
      and (
        p_end is null
        or (c.created_at at time zone 'America/New_York')::date <= p_end
      )
      and (p_campaign is null or c.campaign_id = p_campaign)
      and (p_owner is null or le.owner_id = p_owner)
  ),
  call_stats as (
    select
      list_id,
      count(*)::integer as calls,
      count(*) filter (
        where outcome in (
          'goal_met', 'callback', 'call_back_later', 'not_interested',
          'gatekeeper', 'gatekeeper_not_interested', 'transferred_to_human',
          'language_barrier', 'hung_up_immediately', 'hung_up_later', 'dnc'
        )
      )::integer as connected,
      count(distinct lead_id) filter (
        where deleted_at is null
      )::integer as worked,
      -- The same connected-outcome list, per business rather than per call, so
      -- it divides cleanly by `worked`.
      count(distinct lead_id) filter (
        where deleted_at is null
          and outcome in (
            'goal_met', 'callback', 'call_back_later', 'not_interested',
            'gatekeeper', 'gatekeeper_not_interested', 'transferred_to_human',
            'language_barrier', 'hung_up_immediately', 'hung_up_later', 'dnc'
          )
      )::integer as reached,
      count(*) filter (where outcome = 'voicemail')::integer as voicemail,
      count(distinct lead_id) filter (
        where decision_maker_reached
      )::integer as dms,
      count(distinct lead_id) filter (where goal_met)::integer as goals,
      sum(cost) as spend,
      min(created_at) as first_call,
      max(created_at) as last_call
    from scoped_calls
    group by 1
  ),
  lead_stats as (
    select
      l.list_id,
      count(*)::integer as leads,
      count(*) filter (
        where l.line_type is not null and l.line_type <> 'unknown'
      )::integer as line_typed,
      count(*) filter (where l.line_type = 'mobile')::integer as mobiles,
      count(*) filter (where l.status = 'resting')::integer as resting,
      count(*) filter (
        where l.status = 'dnc'
           or exists (
             select 1 from dnc_entries d
              where d.phone = l.business_phone
                and d.owner_id = l.owner_id
           )
      )::integer as suppressed,
      -- dial_queue's lead-level predicates, and only those. See the header.
      count(*) filter (
        where l.business_phone is not null
          and l.status in ('ready_to_call', 'callback')
          and l.line_type is distinct from 'mobile'
          and not exists (
            select 1 from dnc_entries d
             where d.phone = l.business_phone
               and d.owner_id = l.owner_id
          )
      )::integer as remaining
    from leads l
    where l.deleted_at is null
      and (p_owner is null or l.owner_id = p_owner)
    group by 1
  ),
  bad_leads as (
    select
      le.list_id,
      count(distinct c.lead_id)::integer as bad_number
    from calls c
    join leads le on le.id = c.lead_id
    where c.outcome = 'invalid_number'
      and le.deleted_at is null
      and (p_owner is null or le.owner_id = p_owner)
    group by 1
  ),
  -- Pace. Deliberately unfiltered by date and by campaign, exactly like
  -- bad_leads and the lead_stats inventory block -- see the header.
  worked_recent as (
    select
      le.list_id,
      count(distinct c.lead_id)::integer as worked_7d
    from calls c
    join leads le on le.id = c.lead_id
    where c.created_at >= now() - interval '7 days'
      and le.deleted_at is null
      and (p_owner is null or le.owner_id = p_owner)
    group by 1
  ),
  reg_stats as (
    select
      le.list_id,
      count(*) filter (where ce.status <> 'canceled')::integer as regs,
      count(*) filter (where ce.attended_at is not null)::integer as attended,
      count(*) filter (where ce.sale_at is not null)::integer as sales,
      -- Verbatim from cohort_rows. A session reconciles 24h after it starts;
      -- unmarked past that is a no-show.
      count(*) filter (
        where ce.status <> 'canceled'
          and ce.attended_at is null
          and ce.scheduled_at < now() - interval '24 hours'
      )::integer as no_show,
      -- Still to come: the session has not happened, or has not reconciled.
      count(*) filter (
        where ce.status <> 'canceled'
          and ce.attended_at is null
          and ce.scheduled_at >= now() - interval '24 hours'
      )::integer as pending
    from calendly_events ce
    join leads le on le.id = ce.lead_id
    where (
        p_start is null
        or coalesce(
             ce.dial_day,
             (ce.created_at at time zone 'America/New_York')::date
           ) >= p_start
      )
      and (
        p_end is null
        or coalesce(
             ce.dial_day,
             (ce.created_at at time zone 'America/New_York')::date
           ) <= p_end
      )
      and (p_owner is null or le.owner_id = p_owner)
      and (
        p_campaign is null
        or exists (
          select 1
            from calls c2
           where c2.lead_id = ce.lead_id
             and c2.campaign_id = p_campaign
        )
      )
    group by 1
  ),
  orphan_regs as (
    select
      count(*) filter (where ce.status <> 'canceled')::integer as regs,
      count(*) filter (where ce.attended_at is not null)::integer as attended,
      count(*) filter (where ce.sale_at is not null)::integer as sales,
      count(*) filter (
        where ce.status <> 'canceled'
          and ce.attended_at is null
          and ce.scheduled_at < now() - interval '24 hours'
      )::integer as no_show,
      count(*) filter (
        where ce.status <> 'canceled'
          and ce.attended_at is null
          and ce.scheduled_at >= now() - interval '24 hours'
      )::integer as pending
    from calendly_events ce
    where ce.lead_id is null
      and p_campaign is null
      and (
        p_start is null
        or coalesce(
             ce.dial_day,
             (ce.created_at at time zone 'America/New_York')::date
           ) >= p_start
      )
      and (
        p_end is null
        or coalesce(
             ce.dial_day,
             (ce.created_at at time zone 'America/New_York')::date
           ) <= p_end
      )
      and (p_owner is null or ce.owner_id = p_owner)
  ),
  all_rows as (
    select
      l.id as list_id,
      l.name as list_name,
      l.is_inbound_default as is_inbound,
      coalesce(ls.leads, 0) as leads,
      coalesce(cs.worked, 0) as worked,
      coalesce(cs.calls, 0) as calls,
      coalesce(cs.connected, 0) as connected,
      coalesce(cs.dms, 0) as dms,
      coalesce(cs.goals, 0) as goals,
      coalesce(rs.regs, 0) as regs,
      coalesce(rs.attended, 0) as attended,
      coalesce(rs.sales, 0) as sales,
      coalesce(cs.spend, 0) as spend,
      cs.first_call as first_call,
      cs.last_call as last_call,
      coalesce(cs.reached, 0) as reached,
      coalesce(cs.voicemail, 0) as voicemail,
      coalesce(ls.line_typed, 0) as line_typed,
      coalesce(ls.mobiles, 0) as mobiles,
      coalesce(bl.bad_number, 0) as bad_number,
      coalesce(ls.suppressed, 0) as suppressed,
      coalesce(ls.resting, 0) as resting,
      coalesce(ls.remaining, 0) as remaining,
      coalesce(rs.no_show, 0) as no_show,
      coalesce(rs.pending, 0) as pending,
      coalesce(wr.worked_7d, 0) as worked_7d
    from lists l
    left join lead_stats ls on ls.list_id = l.id
    left join call_stats cs on cs.list_id = l.id
    left join bad_leads bl on bl.list_id = l.id
    left join reg_stats rs on rs.list_id = l.id
    left join worked_recent wr on wr.list_id = l.id
    -- An empty list nobody has ever dialled is noise, not a row.
    where coalesce(ls.leads, 0) > 0
       or coalesce(cs.calls, 0) > 0
       or coalesce(rs.regs, 0) > 0

    union all

    select
      null::uuid, null::text, false,
      0, 0, 0, 0, 0, 0,
      o.regs, o.attended, o.sales,
      0::numeric, null::timestamptz, null::timestamptz,
      0, 0, 0, 0, 0, 0, 0, 0,
      o.no_show, o.pending, 0
    from orphan_regs o
    where o.regs > 0 or o.attended > 0 or o.sales > 0
  )
  select *
    from all_rows
   -- Best-performing first, then busiest. The unattributed row has neither and
   -- settles at the bottom, which is where it belongs.
   order by goals desc, sales desc, calls desc, list_name asc nulls last;
$$;

comment on function public.list_performance(date, date, uuid, uuid) is
  'Per-lead-list performance for the Analytics page. Money: list size, how much '
  'of it has been worked, and the calls, decision-makers, goals, registrations '
  'and spend dialling it produced. Reachability: who answered, how much went to '
  'answerphone, and what is left. Activity columns follow the date and campaign '
  'filters; inventory columns (leads, line_typed, mobiles, bad_number, '
  'suppressed, resting, remaining, worked_7d) are as-of-now and follow neither. '
  'no_show / pending use cohort_rows'' definitions verbatim so a show rate '
  'computed here matches the Cohorts tab. '
  'SECURITY INVOKER so RLS scopes a member to their own lists.';

-- A dropped function is a new function, so its grant has to be re-issued. The
-- event trigger from 20260906050000 has already closed it to PUBLIC / anon by
-- the time this line runs.
grant execute on function public.list_performance(date, date, uuid, uuid) to authenticated;
