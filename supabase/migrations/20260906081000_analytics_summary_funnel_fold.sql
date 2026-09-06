-- analytics_summary must fold the funnel itself. Counts cannot do it later.
--
-- ---------------------------------------------------------------------------
-- The mistake in 20260906080000
--
-- That version returned the RAW funnel stages -- the number of distinct leads
-- that were connected, that held a conversation, that were decision-maker
-- reached -- and left the fold to the page.
--
-- It cannot be left to the page. buildLeadFunnel folds each deeper stage
-- upward with a SET UNION:
--
--     conversations = conversationRaw ∪ goalRaw ∪ dms
--     connected     = connectedRaw ∪ conversations
--
-- and |A ∪ B| is not a function of |A| and |B|. Without the intersections, the
-- page cannot reproduce the folded numbers from the raw counts, so the funnel
-- would have silently stopped narrowing -- which is the exact bug the fold was
-- written to fix (a DM count that exceeded conversations, and a step rate over
-- 100%).
--
-- Caught before anything called the function, so nothing was ever served from
-- the raw counts.
--
-- ---------------------------------------------------------------------------
-- Why the fold is expressible in SQL at all
--
-- Each raw stage is "this lead has at least one call in the window matching P".
-- For a lead that is in the window at all, the union of two such stages is
-- itself a stage of the same form:
--
--     (∃ call: P) ∨ (∃ call: Q)  ≡  ∃ call: (P ∨ Q)
--
-- and `dm` is constant per lead, so it distributes in too. Each folded stage is
-- therefore one `count(distinct lead_id) filter (where P or Q or dm)` rather
-- than a union of materialised sets.
--
-- Written out in full rather than simplified. `goal_met` is already in
-- CONNECTED_OUTCOMES, so `connected or goal_met` collapses to `connected`
-- today -- but spelling out the fold keeps this correct if that set ever
-- changes, and keeps it readable next to the TypeScript it mirrors.
--
-- The raw stages are dropped rather than kept alongside. Nothing needs them,
-- and two similarly-named counts where only one is correct to display is how
-- the wrong one ends up on the page.
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
      count(distinct lead_id) filter (where goal_met)::integer as lead_goal,
      count(distinct lead_id) filter (where goal_met and dm)::integer
        as lead_goal_dm,

      -- The funnel, ALREADY FOLDED. See the header: each stage implies every
      -- shallower one, so the chain narrows monotonically and no step rate can
      -- exceed 100%.
      count(distinct lead_id)::integer as funnel_called,
      count(distinct lead_id) filter (
        where connected or goal_met or dm
      )::integer as funnel_connected,
      count(distinct lead_id) filter (
        where (connected and talked_a_minute) or goal_met or dm
      )::integer as funnel_conversation,
      count(distinct lead_id) filter (where dm)::integer as funnel_dm
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
  'One-round-trip aggregate behind /analytics: KPI components, the ALREADY '
  'FOLDED per-business funnel stages, the outcome distribution, the '
  'per-Eastern-day series and the per-campaign ranking. Replaces paging ~8k '
  'calls into JavaScript twice per page load (20260906080000/081000). Returns '
  'raw sums and counts, never ratios -- computeKpis still derives those. The '
  'funnel IS folded here because |A ∪ B| cannot be recovered from |A| and |B|. '
  'SECURITY INVOKER so RLS scopes a member to their own calls.';

grant execute on function public.analytics_summary(
  timestamptz, timestamptz, uuid, uuid, uuid
) to authenticated;
