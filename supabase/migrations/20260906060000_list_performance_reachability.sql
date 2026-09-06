-- Phase 2 of "Performance by lead list": the reachability half.
--
-- Section 1 answers "was this list worth the money". This answers "is it still
-- worth dialling" -- how much of the list can actually be reached, and how much
-- of it is left. Same function rather than a second one, so both sections share
-- one round trip and can never disagree about `leads` or `worked`.
--
-- DROP then CREATE, because a RETURNS TABLE signature cannot be widened with
-- CREATE OR REPLACE. Backwards compatible in the direction that matters: the
-- deployed page reads columns by name, so it keeps working against the wider
-- function until its own deploy lands.
--
-- ---------------------------------------------------------------------------
-- The new columns, and which of them move with the date pills
--
-- Activity, so they follow the window and the campaign filter exactly like
-- calls / connected / spend:
--
--   reached    Distinct live leads where a PERSON picked up at least once.
--              Same connected-outcome list as `connected`, counted per
--              business instead of per call, so it can sit next to `worked`.
--   voicemail  Calls that reached a machine. A CALL-level count, deliberately
--              -- "how much of the dialling this list absorbs is talking to
--              answerphones" is a property of the calls, not of the leads. The
--              UI labels it as such.
--
-- Inventory, so they are as-of-now and NEVER date-filtered, exactly like
-- `leads`. What is left in a list is not a property of the window you are
-- looking through, and a Remaining that changed when you moved the date pills
-- would be worse than no Remaining at all:
--
--   line_typed  Leads whose phone line type has actually been looked up. Today
--               this is ZERO for every list -- no lookup has ever run, so every
--               lead reads 'unknown'. The UI shows Mobiles as "—" rather than
--               "0.0%" when this is zero, because "we checked and found none"
--               and "we never checked" must not look identical.
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
  remaining integer
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
  reg_stats as (
    select
      le.list_id,
      count(*) filter (where ce.status <> 'canceled')::integer as regs,
      count(*) filter (where ce.attended_at is not null)::integer as attended,
      count(*) filter (where ce.sale_at is not null)::integer as sales
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
      count(*) filter (where ce.sale_at is not null)::integer as sales
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
      coalesce(ls.remaining, 0) as remaining
    from lists l
    left join lead_stats ls on ls.list_id = l.id
    left join call_stats cs on cs.list_id = l.id
    left join bad_leads bl on bl.list_id = l.id
    left join reg_stats rs on rs.list_id = l.id
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
      0, 0, 0, 0, 0, 0, 0, 0
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
  'suppressed, resting, remaining) are as-of-now and follow neither. '
  'SECURITY INVOKER so RLS scopes a member to their own lists.';

-- A dropped function is a new function, so its grant has to be re-issued. The
-- event trigger from 20260906050000 has already closed it to PUBLIC / anon by
-- the time this line runs.
grant execute on function public.list_performance(date, date, uuid, uuid) to authenticated;
