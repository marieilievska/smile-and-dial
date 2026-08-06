-- PHASE 2 (irreversible): drop the call-scoring + call-reviewer database objects.
--
-- Prerequisite: the phase-1 code removal (PR #365) must be DEPLOYED first, so no
-- live code reads calls.score or the review_* objects. Verified deployed
-- (GET /api/review/tick returns 404). The phase-1 cron-unschedule migration
-- (20260806120000) runs before this one by timestamp order, so the review-tick
-- cron — whose guard reads call_reviews — is gone before call_reviews is dropped.
--
-- KEPT deliberately:
--   * public.refresh_cost_rollup(...) — cost infra. It reads only
--     calls.cost_breakdown JSON (the reviewer's openai_review cost is already
--     folded into call rows), NOT call_reviews, so it is unaffected.
--   * cost_breakdown.openai_review values on existing calls — historical spend.

-- Views first (they depend on the tables below).
drop view if exists public.review_bucket_counts;
drop view if exists public.review_summary;

-- Reviewer tables. CASCADE clears the intra-review foreign keys
-- (call_review_flags -> call_reviews / review_flag_defs); nothing outside the
-- reviewer references these.
drop table if exists public.call_review_flags cascade;
drop table if exists public.call_reviews cascade;
drop table if exists public.review_prompt_suggestions cascade;
drop table if exists public.review_flag_defs cascade;

-- Reviewer columns added onto the KEPT agents table.
alter table public.agents
  drop column if exists review_prompt,
  drop column if exists review_prompt_at,
  drop column if exists review_playbook,
  drop column if exists review_playbook_hash,
  drop column if exists review_playbook_at;

-- The 0–10 call-quality score column on the KEPT calls table.
alter table public.calls
  drop column if exists score;

-- After applying, regenerate src/lib/supabase/database.types.ts
-- (`supabase gen types typescript`) so the generated types drop these objects.
