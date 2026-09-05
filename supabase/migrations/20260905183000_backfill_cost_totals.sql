-- Backfill stale per-call totals, then rebuild the whole rollup.
--
-- 1,183 of 7,888 calls carried a `cost_breakdown.total` that no longer
-- matched the sum of its components: the objection worker bumped `openai`
-- without recomputing `total` (fixed in code — every writer now goes through
-- withRecomputedTotal()). Every AGGREGATE re-sums the components, but the
-- Calls list, the call modal, pre_call_check and the spend-cap monitor read
-- the STORED total — so those four under-reported.
--
-- Recompute `total` as call_cost_total() (the component sum) wherever the row
-- is itemized and the stored total differs. Un-itemized legacy rows (a total
-- with no components) are left alone: their total IS the record. Idempotent.

update public.calls c
set cost_breakdown = jsonb_set(
  c.cost_breakdown,
  '{total}',
  to_jsonb(round(public.call_cost_total(c.cost_breakdown), 4))
)
where c.cost_breakdown is not null
  and jsonb_typeof(c.cost_breakdown) = 'object'
  and public.call_cost_components(c.cost_breakdown) > 0
  and abs(
        public.j_num(c.cost_breakdown, 'total')
        - round(public.call_cost_total(c.cost_breakdown), 4)
      ) > 0.00005;

-- Rebuild every ET day: the rollup gained goal_leads and a NULL-tolerant
-- campaign_id (20260905181000), and the totals above changed. Cheap at this
-- size (~8k calls).
select public.refresh_cost_rollup(null);
