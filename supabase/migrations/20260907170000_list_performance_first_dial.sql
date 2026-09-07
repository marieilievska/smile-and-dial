-- Phase 3 of "Performance by lead list": the unit economics, plus the pace
-- window "Days left" has to be measured over.
--
-- Adds the four columns the "Where the money goes" panel needs -- no_show,
-- pending, worked_7d and first_dial. Same function again rather than a second
-- one, so every panel on the page keeps sharing one round trip and they cannot
-- disagree about `leads` or `worked`.
--
-- first_dial is the whole reason this file exists rather than stopping at
-- 20260907160000: Days-left divides `remaining` by a pace, and a pace needs an
-- age to divide by. The only age the function offered was `first_call`, which
-- is ACTIVITY -- with the Today pill selected it becomes this morning, the age
-- collapses to a few hours, and a list with 56 days left renders 11. An
-- inventory column cannot be built out of a filtered one, so first_dial is its
-- own unfiltered CTE.
--
-- This file is the CANONICAL definition of list_performance: it drops and
-- recreates the whole thing, so nothing in 20260906040000 (phase 1),
-- 20260906060000 (phase 2) or 20260907160000 is still live. The whole story is
-- therefore here, including the parts those three wrote.
--
-- DROP then CREATE, because a RETURNS TABLE signature cannot be widened with
-- CREATE OR REPLACE. Backwards compatible in the direction that matters: the
-- deployed page reads columns by name, so it keeps working against the wider
-- function until its own deploy lands. A dropped function is a NEW function
-- and loses its grant, so the GRANT at the foot of this file has to come
-- after the DROP -- tests/list-performance.unit.test.ts pins that order.
--
-- ---------------------------------------------------------------------------
-- Activity vs inventory -- which columns move with the date pills
--
-- Every column is one or the other, and confusing the two is the main way this
-- table could lie.
--
-- ACTIVITY follows the date window and the campaign filter, because it counts
-- what the dialling DID: calls, connected, spend, dms, goals, first_call,
-- last_call, and
--
--   worked      Distinct live leads dialled at least once inside the filter.
--   reached     Distinct live leads where a PERSON picked up at least once.
--               Same connected-outcome list as `connected`, counted per
--               business instead of per call, so it can sit next to `worked`.
--   voicemail   Calls that reached a machine. A CALL-level count, deliberately
--               -- "how much of the dialling this list absorbs is talking to
--               answerphones" is a property of the calls, not of the leads. The
--               UI labels it as such.
--   regs / attended / sales / no_show / pending, dated by the DIAL DAY that
--               paid for them rather than by the day the registration landed.
--
-- INVENTORY is as-of-now and follows NEITHER filter. What is left in a list is
-- not a property of the window you are looking through, and a Remaining that
-- changed when you moved the date pills would be worse than no Remaining at
-- all:
--
--   leads       Live leads in the list right now.
--   line_typed  Leads whose phone line type has actually been looked up. Today
--               this is ZERO for every list -- no lookup has ever run, so every
--               lead reads 'unknown'. The UI shows Mobiles as an em dash rather
--               than "0.0%" when this is zero, because "we checked and found
--               none" and "we never checked" must not look identical.
--   mobiles     Leads locked out of auto-dialling by line_type = 'mobile'
--               (#243). Dead weight in a list you paid for.
--   bad_number  Leads that have ever come back invalid_number. Not
--               date-filtered and not campaign-filtered: a dead number is a
--               property of the lead, not of a window or a campaign.
--   suppressed  Leads that asked us to stop -- status 'dnc', or on their own
--               owner's do-not-call list. Per owner, matching enforcement
--               (20260906020000).
--   resting     Leads sleeping off a not_interested / ai_receptionist rest.
--               Temporarily out, not lost -- worth separating from suppressed.
--   remaining   Still-workable inventory. See below; this one is the trap.
--   worked_7d   Pace: how fast the list is burning. See below.
--   first_dial  The age that pace is divided by. See below -- and note the
--               near-miss with `first_call`, which is the ACTIVITY column of
--               the same shape and must never be used for this.
--
-- ---------------------------------------------------------------------------
-- Why `remaining` is not "count the dial_queue"
--
-- The obvious implementation is wrong. dial_queue is a NOW queue, not an
-- inventory: it is gated on calling hours, on per-hour and per-day caps, on
-- the campaign being active with autopilot on, and on a healthy number being
-- attached. Counting it returns ZERO every night, which as a report column
-- would read as "this list is finished".
--
-- So remaining mirrors only dial_queue's LEAD-level, clock-independent
-- predicates, and nothing else:
--
--     l.deleted_at is null
--     l.business_phone is not null
--     l.status in ('ready_to_call', 'callback')
--     l.line_type is distinct from 'mobile'
--     not exists (dnc_entries d where d.phone = l.business_phone
--                                 and d.owner_id = l.owner_id)
--
-- Deliberately NOT included: next_call_at (a retry that has not come due yet is
-- still inventory), is_within_calling_hours, and every campaign / number / cap
-- condition. tests/list-performance.unit.test.ts pins this list against
-- dial_queue's so the two cannot drift apart silently.
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
-- WARNING to callers: settled is NOT guaranteed to be at most `regs`, and
-- attended / no_show / pending are NOT an exhaustive partition of `regs`.
-- Both flaws are inherited verbatim from cohort_rows and must NOT be repaired
-- here -- the entire point of copying the predicates is that the two functions
-- agree, so diverging would be worse than the flaw. The consumer compensates:
--
--   * `attended` counts attended_at is not null with NO `status <> 'canceled'`
--     guard, while regs, no_show and pending all carry one. A registration
--     marked attended and cancelled afterwards is inside `attended` and
--     outside `regs`, so settled can EXCEED regs and a show rate can read
--     above 100%. Callers must clamp settled to at most regs.
--   * calendly_events.scheduled_at is NULLABLE. A non-cancelled, unattended
--     row with a null scheduled_at satisfies neither the no_show comparison
--     nor the pending one, so it falls out of both buckets. Callers must never
--     derive pending as regs - attended - no_show, and must never present the
--     three as a complete breakdown of regs.
--
-- ---------------------------------------------------------------------------
-- worked_7d and first_dial -- the two halves of pace
--
-- "Days left" is remaining / (worked_7d / pace_days), and pace_days is derived
-- from first_dial. BOTH halves are outbound-only, and BOTH ignore every filter.
-- They have to: a Days-left that changed when you moved the date pills would be
-- worse than no Days-left at all, and it takes only one filtered input to make
-- that happen.
--
--   worked_7d   Distinct live leads DIALLED in the last 7 days.
--   first_dial  The FIRST time we ever dialled this list, as of now. Null for a
--               list that has never been dialled outbound -- Inbound is exactly
--               that case, since all of its calls come the other way.
--
-- OUTBOUND ONLY, both of them. They answer "how fast are we burning through
-- this list, and since when", and only outbound dialling consumes a list. An
-- inbound call is somebody returning a missed call; it costs the list nothing.
-- Without the direction filter the Inbound list would show a pace it never
-- spent, and a Days-left built on that number would be meaningless.
--
-- Note the deliberate asymmetry with `worked` in call_stats, which does NOT
-- filter direction and must not be changed to match. `worked` answers "how
-- many businesses did we interact with", and an inbound conversation is an
-- interaction. Different question, different filter -- this is not an
-- inconsistency waiting to be tidied up.
--
-- ***`first_call` IS NOT `first_dial` AND MUST NEVER BE USED FOR PACE.***
-- They are the same shape and one character apart in meaning, which is exactly
-- why this paragraph exists. `first_call` lives in call_stats: it is ACTIVITY,
-- it follows the date pills and the campaign filter, and it counts inbound
-- calls too. Feed it to a pace window and Days-left stops being a property of
-- the list and becomes a property of the pills. Traced on 2026-09-07: with the
-- Today pill, `first_call` was that morning, the age came out at ~0.1 days, the
-- window floored to 1, and a list with 56 days left rendered 11 -- a fivefold
-- overstatement of a list's remaining life, from two clicks. `first_call` is
-- for "when did the dialling in this window start", and nothing else.
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
  worked_7d integer,
  first_dial timestamptz
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
  -- Pace: how fast this list is being burned through. OUTBOUND ONLY, because
  -- only outbound dialling consumes a list -- an inbound call is somebody
  -- returning a missed call, and it costs the list nothing. `worked` in
  -- call_stats deliberately does NOT filter direction and must not be changed
  -- to match: it answers "how many businesses did we interact with", which is
  -- a different question. Deliberately unfiltered by date and by campaign too,
  -- exactly like bad_leads and the lead_stats inventory block -- see the
  -- header.
  worked_recent as (
    select
      le.list_id,
      count(distinct c.lead_id)::integer as worked_7d
    from calls c
    join leads le on le.id = c.lead_id
    where c.created_at >= now() - interval '7 days'
      and c.direction = 'outbound'
      and le.deleted_at is null
      and (p_owner is null or le.owner_id = p_owner)
    group by 1
  ),
  -- The first time we ever dialled this list. Inventory, not activity: like
  -- worked_7d it ignores the date pills and the campaign filter, because the
  -- pace window it clamps must not move when you change what you are looking
  -- at. `first_call` above is the FILTERED equivalent and must not be used for
  -- this -- with the Today pill it would put the pace window at a few hours
  -- and overstate a list's remaining life fivefold.
  first_dial as (
    select
      le.list_id,
      min(c.created_at) as first_dial
    from calls c
    join leads le on le.id = c.lead_id
    where c.direction = 'outbound'
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
      coalesce(wr.worked_7d, 0) as worked_7d,
      -- No coalesce: a list nobody has dialled outbound has no first dial, and
      -- an epoch would be a lie the pace window would divide by.
      fd.first_dial as first_dial
    from lists l
    left join lead_stats ls on ls.list_id = l.id
    left join call_stats cs on cs.list_id = l.id
    left join bad_leads bl on bl.list_id = l.id
    left join reg_stats rs on rs.list_id = l.id
    left join worked_recent wr on wr.list_id = l.id
    left join first_dial fd on fd.list_id = l.id
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
      o.no_show, o.pending, 0, null::timestamptz
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
  'suppressed, resting, remaining, worked_7d, first_dial) are as-of-now and '
  'follow neither. '
  'no_show / pending use cohort_rows'' definitions verbatim so a show rate '
  'computed here matches the Cohorts tab. '
  'first_dial is the unfiltered first outbound dial and is the ONLY valid age '
  'for a pace window -- first_call is the filtered one and moves with the date '
  'pills. '
  'SECURITY INVOKER so RLS scopes a member to their own lists.';

-- A dropped function is a new function, so its grant has to be re-issued. The
-- event trigger from 20260906050000 has already closed it to PUBLIC / anon by
-- the time this line runs.
grant execute on function public.list_performance(date, date, uuid, uuid) to authenticated;
