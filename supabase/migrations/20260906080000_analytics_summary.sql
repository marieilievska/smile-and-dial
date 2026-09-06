-- Analytics stops pulling every call into JavaScript.
--
-- ---------------------------------------------------------------------------
-- What it was doing
--
-- fetchCallsForRange (src/lib/analytics/stats.ts) pages the whole `calls`
-- window 1,000 rows at a time -- 8,156 calls today, so nine sequential round
-- trips, each carrying the cost_breakdown and extracted_data JSON -- and
-- /analytics calls it TWICE, once for the window and once for the comparison
-- period. Roughly 18 round trips and ~16,000 JSON-bearing rows, all so the page
-- can count them in a for-loop.
--
-- Measured on production 2026-09-06, after the chunked lead lookups were
-- already parallelised (#477): /analytics 5,360-5,924ms, /reporting ~4,500ms.
--
-- This is the same shape as the /campaigns bug fixed in 20260906070000 --
-- fetch everything, aggregate in JS -- and the last large instance of it.
-- 20260906055000 already predicted where it ends: `authenticated` carries
-- statement_timeout=8s, and at ~19,000 calls in a window the page throws.
--
-- ---------------------------------------------------------------------------
-- What this returns, and what stays in TypeScript
--
-- One jsonb, one round trip, four sections:
--
--   totals      every per-call counter and every distinct-lead counter the
--               KPI block and the funnel need, as raw components -- sums and
--               counts, never ratios.
--   outcomes    [{outcome, count}], the outcome distribution.
--   byDay       [{day, calls, spend, goalLeads}] on the EASTERN calendar day,
--               the app-wide convention (same expression as the cost rollup).
--   byCampaign  [{campaignId, goalMet, spend}] for the campaign ranking.
--
-- Deliberately NOT computed here:
--
--   * Ratios. connectRate, goalMetRate, avgDurationSeconds, avgCostPerCall and
--     costPerGoalMet stay in computeKpis, derived from these components. A
--     ratio computed in two places is a ratio that will disagree in two places,
--     and the divide-by-zero rules are already written and tested there.
--   * The funnel's monotonic fold. buildLeadFunnel folds each deeper stage
--     upward so the chain narrows -- that is display logic about a true funnel,
--     not a fact about the data, and it belongs next to the component that
--     draws it.
--   * The day grid. The page pre-seeds every date in the range so the chart has
--     no gaps; this returns only days that had calls.
--
-- ---------------------------------------------------------------------------
-- Decisions worth knowing
--
-- SECURITY INVOKER. The old code read `calls` and `leads` through the
-- signed-in user's client, so RLS already scoped a member to their own rows.
-- INVOKER preserves that exactly. A DEFINER function would have silently shown
-- every member the whole workspace's analytics.
--
-- LEFT JOIN leads, not an inner join. A call with no lead (or a lead the
-- caller cannot see) still counts toward the per-call metrics, which is what
-- the JS did -- it only dropped such calls when an owner or list filter was
-- set, and the `p_owner is null or ...` predicates reproduce that: a null lead
-- fails `l.owner_id = p_owner` and drops, exactly as `dmByLead.has()` did.
-- There are no such rows today (0 of 8,156), but the behaviour should not
-- change the first time there are.
--
-- Soft-deleted leads are NOT excluded, because the JS did not exclude them.
-- Also zero rows today. Called out so the omission reads as deliberate.
--
-- `dm` reads the LEAD's decision_maker_reached, never the call's frozen AI
-- extraction -- the operator-correctable flag, matching rowReachedDm().
--
-- Window bounds arrive as timestamptz rather than dates: the ET day-boundary
-- maths already lives in lib/time/eastern (etDayRangeUtc / endOfEtDayUtcIso)
-- and the caller passes the same instants it used before. One definition of
-- "the start of an Eastern day", not two.
create or replace function public.analytics_summary(
  p_start timestamptz,
  p_end timestamptz,
  p_campaign uuid default null,
  p_owner uuid default null,
  p_list uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with scoped as (
    select
      c.lead_id,
      c.campaign_id,
      c.goal_met,
      c.outcome,
      c.duration_seconds,
      public.call_cost_total(c.cost_breakdown) as cost,
      -- The LEAD's sticky flag, not the call's extraction. Operator
      -- corrections must be reflected here (rowReachedDm in stats.ts).
      (l.decision_maker_reached is true) as dm,
      -- CONNECTED_OUTCOMES -- keep in step with src/lib/calls/outcomes.ts.
      -- tests/analytics-summary.unit.test.ts fails if these two drift.
      (c.outcome in (
        'goal_met',
        'callback',
        'call_back_later',
        'not_interested',
        'gatekeeper',
        'gatekeeper_not_interested',
        'transferred_to_human',
        'language_barrier',
        'hung_up_immediately',
        'hung_up_later',
        'dnc'
      )) as connected,
      -- CONVERSATION_OUTCOMES -- keep in step with src/lib/calls/outcomes.ts.
      (c.outcome in (
        'goal_met',
        'callback',
        'not_interested',
        'gatekeeper',
        'gatekeeper_not_interested',
        'transferred_to_human',
        'language_barrier'
      )) as conversation,
      -- A real conversation is a connected call where someone talked for a
      -- minute. ElevenLabs never populates talk_time_seconds, so the fallback
      -- to duration_seconds is load-bearing -- without it this reads 0 for
      -- every call, which was the "Conversations: 0" bug.
      (coalesce(c.talk_time_seconds, c.duration_seconds, 0) >= 60)
        as talked_a_minute,
      (c.created_at at time zone 'America/New_York')::date as et_day
    from calls c
    left join leads l on l.id = c.lead_id
    where c.created_at >= p_start
      and c.created_at <= p_end
      and (p_campaign is null or c.campaign_id = p_campaign)
      and (p_owner is null or l.owner_id = p_owner)
      and (p_list is null or l.list_id = p_list)
  ),
  totals as (
    select
      count(*)::integer as total_calls,
      count(*) filter (where connected)::integer as connected,
      -- ai_error is OUR platform failure, not a real call. Returned so the
      -- page can keep it out of the connect-rate denominator.
      count(*) filter (where outcome = 'ai_error')::integer as ai_error,
      count(*) filter (where conversation)::integer as conversations,
      count(*) filter (where dm)::integer as dms_reached,
      count(*) filter (where outcome = 'callback')::integer as callbacks,
      count(*) filter (where outcome = 'dnc')::integer as dnc_additions,
      -- Sum and count, not the average: computeKpis owns the divide-by-zero
      -- rule, and averaging in both places is how two pages start disagreeing.
      coalesce(sum(duration_seconds), 0)::numeric as duration_sum,
      count(*) filter (where duration_seconds is not null)::integer
        as duration_count,
      coalesce(sum(cost), 0)::numeric as spend,
      -- Distinct BUSINESSES, never calls -- the app-wide goal rule (#279).
      count(distinct lead_id)::integer as lead_called,
      count(distinct lead_id) filter (where connected)::integer
        as lead_connected,
      count(distinct lead_id) filter (where connected and talked_a_minute)
        ::integer as lead_conversation,
      count(distinct lead_id) filter (where dm)::integer as lead_dm,
      count(distinct lead_id) filter (where goal_met)::integer as lead_goal,
      count(distinct lead_id) filter (where goal_met and dm)::integer
        as lead_goal_dm
    from scoped
  ),
  outcomes as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object('outcome', o, 'count', n)
        order by n desc, o
      ),
      '[]'::jsonb
    ) as j
    from (
      select coalesce(outcome, 'no_outcome') as o, count(*)::integer as n
      from scoped
      group by 1
    ) t
  ),
  by_day as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object('day', d::text, 'calls', n, 'spend', s,
                           'goalLeads', g)
        order by d
      ),
      '[]'::jsonb
    ) as j
    from (
      select
        et_day as d,
        count(*)::integer as n,
        coalesce(sum(cost), 0)::numeric as s,
        count(distinct lead_id) filter (where goal_met)::integer as g
      from scoped
      group by 1
    ) t
  ),
  by_campaign as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object('campaignId', cid, 'goalMet', g, 'spend', s)
        order by g desc
      ),
      '[]'::jsonb
    ) as j
    from (
      select
        campaign_id as cid,
        -- A business that hit its goal under two campaigns is credited to
        -- EACH, once -- so these can sum higher than the global distinct
        -- total. Same rule rankCampaigns applied.
        count(distinct lead_id) filter (where goal_met)::integer as g,
        coalesce(sum(cost), 0)::numeric as s
      from scoped
      group by 1
    ) t
  )
  select jsonb_build_object(
    'totals', (select to_jsonb(t) from totals t),
    'outcomes', (select j from outcomes),
    'byDay', (select j from by_day),
    'byCampaign', (select j from by_campaign)
  );
$$;

comment on function public.analytics_summary(
  timestamptz, timestamptz, uuid, uuid, uuid
) is
  'One-round-trip aggregate behind /analytics: KPI components, the per-business '
  'funnel stages, the outcome distribution, the per-Eastern-day series and the '
  'per-campaign ranking. Replaces paging ~8k calls into JavaScript twice per '
  'page load (20260906080000). Returns raw sums and counts, never ratios -- '
  'computeKpis still derives those. SECURITY INVOKER so RLS scopes a member to '
  'their own calls, exactly as the paged read did.';

-- The event trigger from 20260906050000 has already closed this to PUBLIC and
-- anon; the page calls it as a signed-in user.
grant execute on function public.analytics_summary(
  timestamptz, timestamptz, uuid, uuid, uuid
) to authenticated;

-- ---------------------------------------------------------------------------
-- The index this needs
--
-- Every call site filters on created_at and most add campaign_id, so lead the
-- index with created_at (the range) and carry campaign_id for the equality.
-- lead_id and goal_met ride along so the distinct-business counts can be
-- answered without returning to the heap for every row.
create index if not exists calls_created_campaign_idx
  on public.calls (created_at, campaign_id)
  include (lead_id, goal_met);

comment on index public.calls_created_campaign_idx is
  'Range scan for analytics_summary and the other windowed call aggregates '
  '(20260906080000).';
