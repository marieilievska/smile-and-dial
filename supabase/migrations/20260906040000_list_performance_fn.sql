-- Per-lead-list performance rows for the Analytics page.
--
-- Answers "which list was worth the money": every list the caller can see,
-- with the size of the list beside what dialling it actually produced.
--
-- SECURITY INVOKER, deliberately, copying cohort_rows (20260905130000): this
-- runs as the CALLER so row-level security decides which lists, leads, calls
-- and registrations are counted. A super admin sees everything, everyone else
-- sees their own. SECURITY DEFINER here would show every member every other
-- member's lists through a report that looks correctly scoped in the UI.
--
-- The aggregation lives in SQL because PostgREST caps every response at 1000
-- rows: grouping 84k leads in JavaScript would silently undercount, which is
-- exactly how Analytics once showed 900 of 1,431 leads (#218).
--
-- The connected-outcome list MUST stay in step with CONNECTED_OUTCOMES in
-- src/lib/calls/outcomes.ts. tests/list-performance.unit.test.ts pins the two
-- together.
--
-- ---------------------------------------------------------------------------
-- What each column counts, and why the denominators differ
--
--   leads    Live leads in the list, right now. NOT date-filtered -- a list's
--            size is a property of the list, not of the window you are looking
--            through. This is the denominator that makes lists comparable: a
--            list that "converts badly" is usually a list that is 8% dialled.
--   worked   Distinct LIVE leads with at least one call in the filter, so
--            worked / leads is a real percentage that cannot exceed 100%.
--   calls    Every call row in the filter, all directions and statuses, per the
--            app-wide rule (2026-09-03). This INCLUDES calls to leads that have
--            since been deleted, because those calls really did cost money and
--            spend has to reconcile with the Costs page. So a list can show
--            calls > 0 with worked = 0 if all of its leads were deleted.
--   dms      Distinct leads whose operator-correctable decision_maker_reached
--            flag is set -- distinct BUSINESSES, matching the Analytics funnel.
--            Note this differs from cohort_rows.dms, which counts calls.
--   goals    Distinct leads with a goal-met call. "Goals met = distinct
--            businesses" is the app-wide rule (#279), never goal-met calls.
--   spend    Sum of call_cost_total(), the derivation the Costs page uses --
--            never the stored `total`, which goes stale. Verified to
--            reconcile: all-time call spend equals the cost roll-up total.
--
-- Registrations are credited to a list through their lead, and dated by
-- dial_day -- the day whose spend bought them -- falling back to created_at for
-- rows written before dial_day existed, exactly as cohort_rows does.
--
-- A registration with no lead cannot be traced to a list. Rather than let it
-- vanish from the totals it comes back as one extra row with a null list_id,
-- which the UI labels "Unattributed". It is omitted when a campaign filter is
-- set, since a registration with no lead has no calls and so cannot belong to
-- a campaign.
--
-- All four arguments are nullable and each means "no filter", so one function
-- serves the section's All time / This range toggle as well as the page's
-- existing campaign and owner filters.
create or replace function public.list_performance(
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
  last_call timestamptz
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
    select list_id, count(*)::integer as leads
    from leads
    where deleted_at is null
      and (p_owner is null or owner_id = p_owner)
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
      cs.last_call as last_call
    from lists l
    left join lead_stats ls on ls.list_id = l.id
    left join call_stats cs on cs.list_id = l.id
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
      0::numeric, null::timestamptz, null::timestamptz
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
  'Per-lead-list performance for the Analytics page: list size and how much of '
  'it has been worked, beside the calls, decision-makers, goals, registrations '
  'and spend that dialling it produced. Every argument is an optional filter. '
  'SECURITY INVOKER so RLS scopes a member to their own lists.';

grant execute on function public.list_performance(date, date, uuid, uuid) to authenticated;
