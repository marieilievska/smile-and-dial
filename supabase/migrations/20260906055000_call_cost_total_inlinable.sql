-- Make call_cost_total inlinable. It was 91% of the Analytics list query.
--
-- ---------------------------------------------------------------------------
-- Measured, not guessed
--
-- The per-list report aggregates 8,156 call rows and took 3.5 s. Replacing the
-- single expression `public.call_cost_total(c.cost_breakdown)` with a constant
-- took the same query to 0.3 s. EXPLAIN ANALYZE puts the whole gap inside one
-- GroupAggregate: 91 ms in, 4,918 ms out.
--
-- The cause is a PostgreSQL rule that is easy to walk into: **a SQL function
-- carrying a SET clause cannot be inlined.** call_cost_total delegated to
-- call_cost_components and j_num, both `SET search_path TO ''`, so each row
-- paid real function-call overhead for eighteen nested calls (j_num five times
-- inside call_cost_components, which call_cost_total invoked twice, plus the
-- total fallback). Roughly 150,000 uninlinable calls per page load.
--
-- Left alone this was a dated failure, not a slow page. `authenticated` carries
-- statement_timeout=8s, so at ~19,000 calls the query crosses it and the whole
-- Analytics page throws. At ~2,000 dials a day that is about six weeks out.
--
-- ---------------------------------------------------------------------------
-- What changed, and what did not
--
-- The BODY only. Same signature, same IMMUTABLE, same result on every row.
--
--   * No SET clause, so the planner can inline it. `pg_catalog.jsonb_typeof`
--     is schema-qualified instead, which keeps the hardening the SET was there
--     for without blocking inlining. It is not SECURITY DEFINER and never was,
--     so it already ran with the caller's own rights -- a hijacked search_path
--     would gain nothing the caller does not already have.
--   * No nested helper calls. The five component keys are read directly. They
--     must stay in step with COST_COMPONENT_KEYS in src/lib/costs/breakdown.ts,
--     which tests/list-performance.unit.test.ts now pins.
--   * `coalesce(nullif(greatest(sum, 0), 0), total)` reproduces the old
--     `case when components > 0 then components else total end` exactly,
--     including the negative-components branch, while writing the sum once --
--     writing it twice would have doubled the work and invited the two copies
--     to drift.
--
-- Proven equivalent before shipping, against every live row: 8,156 rows
-- compared, 0 mismatches, and both sides summing to 747.9720999999999999676.
--
-- call_cost_components and j_num are left exactly as they are. They still
-- document the key list and still serve their other callers; they are simply
-- no longer in this hot path. refresh_cost_rollup and
-- monitor_campaign_spend_caps go through call_cost_total, so both get the same
-- speed-up for free.
create or replace function public.call_cost_total(j jsonb)
returns numeric
language sql
immutable
parallel safe
as $$
  select coalesce(
    nullif(
      greatest(
          (case when pg_catalog.jsonb_typeof(j -> 'twilio') = 'number'
                then (j ->> 'twilio')::numeric else 0 end)
        + (case when pg_catalog.jsonb_typeof(j -> 'elevenlabs') = 'number'
                then (j ->> 'elevenlabs')::numeric else 0 end)
        + (case when pg_catalog.jsonb_typeof(j -> 'openai') = 'number'
                then (j ->> 'openai')::numeric else 0 end)
        + (case when pg_catalog.jsonb_typeof(j -> 'openai_review') = 'number'
                then (j ->> 'openai_review')::numeric else 0 end)
        + (case when pg_catalog.jsonb_typeof(j -> 'lookup') = 'number'
                then (j ->> 'lookup')::numeric else 0 end),
        0
      ),
      0
    ),
    case when pg_catalog.jsonb_typeof(j -> 'total') = 'number'
         then (j ->> 'total')::numeric else 0 end
  );
$$;

comment on function public.call_cost_total(jsonb) is
  'A call''s cost: the itemised component sum when the row is itemised, else '
  'the stored total. Mirrors breakdownTotal() in src/lib/costs/breakdown.ts. '
  'Written as one inlinable expression with no SET clause and no nested helper '
  'calls, deliberately -- a SQL function with a SET clause cannot be inlined, '
  'and the nested version cost 3.2s per 8k rows (20260906055000).';
