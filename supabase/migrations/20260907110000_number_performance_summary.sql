-- The Numbers tab stops paging 7,798 calls to produce ~200 integers.
--
-- ---------------------------------------------------------------------------
-- What it was doing
--
-- NumbersPanel (src/app/(app)/reporting/numbers-panel.tsx) pages every
-- outbound call in the 30-day window 1,000 rows at a time, then walks the
-- result building three small Maps: connect rate by local-presence tier (3
-- keys), by destination country (2 keys) and by phone number (97 keys). About
-- 200 integers, bought with eight sequential round trips.
--
-- Measured against production 2026-09-07, each query timed on its own:
--
--   paged outbound calls (8 pages)   3,970ms   7,798 rows
--   twilio_numbers                     158ms      97 rows
--   campaigns                          196ms       1 row
--   twilio_number_daily_stats (14d)    155ms     308 rows
--
-- The tab took 3,300-3,700ms warm. The scan is essentially all of it.
--
-- This is the fifth and last instance of the pattern the September audit kept
-- finding -- fetch every row, aggregate in JavaScript -- after 20260906070000
-- (campaigns), 20260906080000 (analytics), 20260907090000 (the reporting
-- dashboard) and 20260907100000 (cause of death).
--
-- ---------------------------------------------------------------------------
-- A note on the payload, because the audit got this wrong
--
-- The same audit recorded the tab as "538 KB" and implied that was a second
-- problem to fix. It is not: 538 KB is the DECODED size. The navigation entry
-- reports encodedBodySize 31 KB against decodedBodySize 538 KB -- 97 table
-- rows whose bytes are 61% repeated Tailwind class strings, which brotli
-- flattens about 17:1. Cause of Death's megabyte was 7,500 DISTINCT company
-- names, which is real weight; this is not the same thing, and the table is
-- deliberately left whole. Scanning all 97 numbers at once is the point of it.
--
-- ---------------------------------------------------------------------------
-- What this returns, and what stays in TypeScript
--
-- One jsonb, one round trip, three maps of raw pairs:
--
--   byMatch    {exact|state|none: {calls, connected}}
--   byCountry  {US|CA: {calls, connected}}
--   byNumber   {<twilio_number_id>: {calls, connected}}
--
-- Counts only. Every rate, the local-presence lift and the percentage
-- formatting stay in the panel, next to the component that draws them -- the
-- same split as the four RPCs before this one. A ratio computed in two places
-- is a ratio that will disagree in two places.
--
-- byNumber deliberately includes numbers that have since been released. The
-- panel only reads the ids it renders, so those entries go unused, exactly as
-- they did in the Map; returning them keeps this a faithful replacement rather
-- than a slightly different question.
--
-- ---------------------------------------------------------------------------
-- The three things that are easy to get wrong here
--
-- 1. ai_error is dropped from the numerator AND the denominator. It is OUR
--    platform failure, not a call, so an ElevenLabs credit outage must neither
--    inflate nor tank a number's connect rate. Written as
--    `coalesce(outcome, '') <> 'ai_error'` rather than `outcome <> 'ai_error'`,
--    which is NULL -- and therefore false -- for a call with no outcome yet,
--    silently dropping every such row. The JS said `if (c.outcome ===
--    'ai_error') continue`, which keeps them.
--
-- 2. Each map skips its own NULL key, and they are not the same rows: 23
--    outbound calls carry no local_match (placed before the tier was recorded,
--    and excluded rather than counted as "not local", which would understate
--    the baseline) and 22 carry no twilio_number_id. Hence a `where ... is not
--    null` per grouping, not one shared filter. jsonb_object_agg would also
--    throw on a null key.
--
-- 3. `base` is referenced three times, so Postgres materialises it and the
--    calls table is scanned once, not three times.
--
-- No new index. The window covers 7,798 of the table's 8,156 rows, so the
-- planner will pick a sequential scan whatever is offered, and an index built
-- for a predicate that matches 96% of the table is dead weight.
--
-- SECURITY INVOKER, like its four siblings: the panel read `calls` through the
-- signed-in user's client, so RLS already scoped a member to their own rows,
-- and INVOKER preserves that exactly.
create or replace function public.number_performance_summary(
  p_since timestamptz
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with base as (
    select
      c.local_match,
      c.dest_country,
      c.twilio_number_id,
      -- CONNECTED_OUTCOMES -- keep in step with src/lib/calls/outcomes.ts.
      -- tests/number-performance-summary.unit.test.ts fails if these drift.
      -- A NULL outcome yields NULL here, which `filter (where connected)`
      -- treats as not-connected -- matching `c.outcome !== null && has(...)`.
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
      )) as connected
    from calls c
    where c.direction = 'outbound'
      and c.created_at >= p_since
      -- NON_CALL_OUTCOMES -- keep in step with src/lib/calls/outcomes.ts.
      and coalesce(c.outcome, '') <> 'ai_error'
  ),
  by_match as (
    select
      local_match as k,
      count(*)::integer as calls,
      count(*) filter (where connected)::integer as connected
    from base
    where local_match is not null
    group by local_match
  ),
  by_country as (
    select
      dest_country as k,
      count(*)::integer as calls,
      count(*) filter (where connected)::integer as connected
    from base
    where dest_country is not null
    group by dest_country
  ),
  by_number as (
    select
      twilio_number_id::text as k,
      count(*)::integer as calls,
      count(*) filter (where connected)::integer as connected
    from base
    where twilio_number_id is not null
    group by twilio_number_id
  )
  select jsonb_build_object(
    'byMatch', coalesce(
      (
        select jsonb_object_agg(
          k, jsonb_build_object('calls', calls, 'connected', connected)
        )
        from by_match
      ),
      '{}'::jsonb
    ),
    'byCountry', coalesce(
      (
        select jsonb_object_agg(
          k, jsonb_build_object('calls', calls, 'connected', connected)
        )
        from by_country
      ),
      '{}'::jsonb
    ),
    'byNumber', coalesce(
      (
        select jsonb_object_agg(
          k, jsonb_build_object('calls', calls, 'connected', connected)
        )
        from by_number
      ),
      '{}'::jsonb
    )
  );
$$;

comment on function public.number_performance_summary(timestamptz) is
  'Connect-rate rollup for the Reporting Numbers tab: outbound calls and '
  'connections in the window, grouped by local-presence tier, destination '
  'country and phone number. Replaces paging ~7.8k calls into JavaScript to '
  'build three small Maps (20260907110000). Counts only -- every rate and the '
  'local-presence lift stay in TypeScript. ai_error is excluded from both the '
  'numerator and the denominator. SECURITY INVOKER, so RLS scopes a member to '
  'their own calls.';

-- The event trigger from 20260906050000 has already closed this to PUBLIC and
-- anon. The Numbers tab calls it as the signed-in user; the tab is hidden from
-- the public share surface (reportingTabsFor showNumbers: false), so there is
-- no service-role caller.
grant execute on function public.number_performance_summary(timestamptz)
  to authenticated;
