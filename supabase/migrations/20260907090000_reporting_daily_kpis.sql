-- The Reporting dashboard stops paging every call into JavaScript.
--
-- ---------------------------------------------------------------------------
-- What it was doing
--
-- fetchDashboardKpis (src/lib/agent-analytics/report-data.ts) pages the last 30
-- Eastern days of `calls` 1,000 rows at a time and groups them per day in a
-- for-loop. Each row carries `extracted_data`, so the pages are fat: measured
-- on production, one page is 233 KB and takes 0.5-0.7s, and there are nine of
-- them, end to end.
--
-- Measured 2026-09-07, the Reporting dashboard -- the tab everyone lands on --
-- takes ~4,700ms to return 108 KB of HTML. Almost all of it is that loop.
--
-- Third instance of the same shape, after /campaigns (20260906070000) and
-- /analytics (20260906080000): fetch everything, aggregate in the app.
--
-- ---------------------------------------------------------------------------
-- What this returns
--
-- One jsonb array, one row per Eastern day that had calls, newest first --
-- about thirty rows instead of eight thousand. Every counter computeDailyKpis
-- tallies, with the same names, so the mapping on the other side is a rename
-- and nothing more.
--
-- Days with no calls are absent, deliberately: computeDailyKpis never created
-- them either, and the dashboard's day list is built from what came back.
--
-- ---------------------------------------------------------------------------
-- Two things deliberately NOT done here
--
-- The sentiment LEXICON stays in TypeScript. This returns `sentimentCounts` as
-- a plain {value: count} object and lets isWarm() in
-- src/lib/agent-analytics/field-detect.ts decide what "warm" means, exactly as
-- before. Copying POSITIVE/NEUTRAL/NEGATIVE into SQL would have created a
-- second lexicon to keep in step for no gain -- the counting is the expensive
-- part, not the classification.
--
-- warmPct is likewise still derived in TypeScript, from those counts. Same
-- reasoning as analytics_summary: a ratio computed in two places is a ratio
-- that will disagree in two places.
--
-- ---------------------------------------------------------------------------
-- Decisions worth knowing
--
-- SECURITY INVOKER. Reporting is open to members, scoped by RLS to the leads
-- they own (see the comment in reporting/page.tsx). The public share surface
-- reaches this through a SERVICE-ROLE client, which bypasses RLS by design and
-- so still sees the whole workspace. Both behaviours are preserved exactly;
-- a DEFINER function would have handed every member the whole workspace.
--
-- `> 60`, not `>= 60`. computeDailyKpis uses a strict greater-than for
-- convGt1min, and analytics_summary uses `>= 60` for its own conversation
-- stage. They are genuinely different thresholds on different columns
-- (duration vs talk-time-then-duration); this one mirrors ITS caller.
--
-- Rows with a null created_at are skipped, matching the `if (!r.created_at)
-- continue` guard -- such a row has no Eastern day to belong to.
create or replace function public.reporting_daily_kpis(
  p_since timestamptz,
  p_campaign_ids uuid[] default null,
  p_sentiment_key text default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with scoped as (
    select
      (c.created_at at time zone 'America/New_York')::date as et_day,
      c.lead_id,
      c.outcome,
      -- CONNECTED_OUTCOMES -- keep in step with src/lib/calls/outcomes.ts.
      -- tests/reporting-daily-kpis.unit.test.ts fails if these two drift.
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
      -- callReachedDm(): the AI's transcript-driven flag, VETOED by outcomes
      -- that definitionally reached nobody or reached a gatekeeper. Without the
      -- veto a mis-flagged gatekeeper counts as a decision-maker, which is the
      -- bug OUTCOME_EXCLUDES_DM exists to stop.
      --
      -- coalesce to '' rather than a NOT IN over a nullable column: a null
      -- outcome must NOT veto (callReachedDm only vetoes when `outcome != null`
      -- and is in the set), and `null not in (…)` is NULL, which would silently
      -- drop the row from the count instead.
      (
        coalesce(c.outcome, '') not in (
          -- OUTCOME_EXCLUDES_DM -- keep in step with lib/calls/decision-maker.ts.
          'gatekeeper',
          'gatekeeper_not_interested',
          'voicemail',
          'no_answer',
          'busy',
          'failed',
          'invalid_number',
          'ai_receptionist',
          'ai_error',
          'hung_up_immediately',
          'hung_up_later'
        )
        and lower(btrim(coalesce(
          c.extracted_data ->> 'decision_maker_reached', ''
        ))) = 'yes'
      ) as dm,
      -- Strictly greater than a minute, matching computeDailyKpis. Duration
      -- alone is not a conversation, so this is only counted on a connected
      -- call -- which also keeps it a subset of `connected`.
      (coalesce(c.duration_seconds, 0) > 60) as over_a_minute,
      case
        when p_sentiment_key is null then null
        else nullif(
          lower(btrim(coalesce(c.extracted_data ->> p_sentiment_key, ''))), ''
        )
      end as sentiment
    from calls c
    where c.created_at is not null
      and c.created_at >= p_since
      and (p_campaign_ids is null or c.campaign_id = any (p_campaign_ids))
  ),
  per_day as (
    select
      et_day,
      count(*)::integer as calls_made,
      count(*) filter (where connected)::integer as connected,
      count(*) filter (where connected and over_a_minute)::integer
        as conv_gt_1min,
      count(*) filter (where dm)::integer as dms,
      count(*) filter (where outcome = 'callback')::integer as callbacks,
      -- Goals per BUSINESS, not per call (#279): a lead with two goal-met
      -- calls on one day is one win that day.
      count(distinct lead_id) filter (
        where outcome = 'goal_met' and lead_id is not null
      )::integer as goals,
      count(*) filter (where outcome = 'not_interested')::integer
        as not_interested,
      count(*) filter (where outcome = 'gatekeeper')::integer as gatekeeper,
      count(*) filter (where outcome = 'gatekeeper_not_interested')::integer
        as gatekeeper_declined,
      count(*) filter (where outcome = 'hung_up_immediately')::integer
        as hung_up,
      count(*) filter (where outcome = 'hung_up_later')::integer
        as hung_up_later,
      count(*) filter (where outcome = 'ai_error')::integer as ai_error,
      count(*) filter (where outcome = 'dnc')::integer as dnc
    from scoped
    group by et_day
  ),
  sentiment_per_day as (
    select
      et_day,
      jsonb_object_agg(sentiment, n) as counts
    from (
      select et_day, sentiment, count(*)::integer as n
      from scoped
      where sentiment is not null
      group by et_day, sentiment
    ) s
    group by et_day
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'day', d.et_day::text,
        'callsMade', d.calls_made,
        'connected', d.connected,
        'convGt1min', d.conv_gt_1min,
        'dms', d.dms,
        'callbacks', d.callbacks,
        'goals', d.goals,
        'notInterested', d.not_interested,
        'gatekeeper', d.gatekeeper,
        'gatekeeperDeclined', d.gatekeeper_declined,
        'hungUp', d.hung_up,
        'hungUpLater', d.hung_up_later,
        'aiError', d.ai_error,
        'dnc', d.dnc,
        'sentimentCounts', coalesce(sp.counts, '{}'::jsonb)
      )
      -- Newest day first, matching computeDailyKpis' sort.
      order by d.et_day desc
    ),
    '[]'::jsonb
  )
  from per_day d
  left join sentiment_per_day sp on sp.et_day = d.et_day;
$$;

comment on function public.reporting_daily_kpis(
  timestamptz, uuid[], text
) is
  'Per-Eastern-day KPI rows for the Reporting dashboard, newest first. Replaces '
  'paging ~8k calls (with their extracted_data) into JavaScript on every load '
  '(20260907090000). Returns counts only -- the sentiment lexicon and warmPct '
  'stay in TypeScript so there is one definition of "warm". SECURITY INVOKER, so '
  'RLS scopes a member to their own leads and the service-role share surface '
  'still sees the workspace.';

-- The event trigger from 20260906050000 has already closed this to PUBLIC and
-- anon. The authed page calls it as the signed-in user; the share page calls it
-- as the service role.
grant execute on function public.reporting_daily_kpis(timestamptz, uuid[], text)
  to authenticated;
