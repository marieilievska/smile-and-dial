-- Cause of Death Phase 2: per-call objection intelligence.
--
-- The AI objection worker (src/lib/reporting/objection-worker.ts) fills these
-- from the transcript of each CONVERSATION call that didn't reach the goal.
-- objection_analyzed_at is set even when no objection is found, so a call is
-- analyzed at most once. Nullable + additive → safe to deploy before the code.
alter table public.calls
  add column if not exists objection_category text,
  add column if not exists objection_specific text,
  add column if not exists objection_quote text,
  add column if not exists objection_analyzed_at timestamptz;

-- The worker's queue: not-yet-analyzed conversation calls that didn't win.
-- Partial index keeps it tiny and the "claim next batch" scan index-only.
create index if not exists idx_calls_objection_pending
  on public.calls (started_at)
  where objection_analyzed_at is null
    and goal_met = false
    and outcome in (
      'not_interested', 'gatekeeper', 'callback',
      'transferred_to_human', 'language_barrier'
    );

comment on column public.calls.objection_category is
  'Cause of Death Phase 2: AI-classified objection (price / already_have_solution / no_need / bad_timing / happy_with_current / confused_by_offer / distrust_spam / brush_off / other), or null when none/not-yet-analyzed.';
