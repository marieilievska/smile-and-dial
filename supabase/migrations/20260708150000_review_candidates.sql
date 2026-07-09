-- Phase 3 (Discovery): candidate metadata on the rubric. A candidate is a row
-- with is_candidate=true, active=false, dismissed_at IS NULL. Approve →
-- is_candidate=false, active=true. Dismiss → dismissed_at=now() (kept, not
-- deleted, so the hourly pass can be told "don't re-propose this").
alter table public.review_flag_defs
  add column if not exists rationale text,
  add column if not exists example_call_ids uuid[] not null default '{}',
  add column if not exists proposed_at timestamptz,
  add column if not exists dismissed_at timestamptz;

-- Fast lookup of the three candidate cohorts the discovery prompt + UI need.
create index if not exists review_flag_defs_candidate_idx
  on public.review_flag_defs (is_candidate, dismissed_at);
