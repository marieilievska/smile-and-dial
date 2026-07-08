-- Phase 2 (Review UI): server-side aggregation so bucket/summary counts are
-- correct at 10k calls/day (client-side counting would hit PostgREST's 1000-row
-- cap and undercount). security_invoker=true → the admin-only RLS on
-- call_review_flags / call_reviews applies to these views too.

-- Per-flag bucket counts. Rejected flags are excluded (only confirmed +
-- needs_review count toward a bucket). unreviewed = the call has not been
-- marked reviewed yet (call_reviews.reviewed_at is null).
create or replace view public.review_bucket_counts
with (security_invoker = true) as
select
  f.flag_key                                                             as flag_key,
  count(*) filter (where f.status = 'confirmed')                         as confirmed_count,
  count(*) filter (where f.status = 'needs_review')                      as needs_review_count,
  count(*) filter (
    where f.status in ('confirmed', 'needs_review') and r.reviewed_at is null
  )                                                                      as unreviewed_count
from public.call_review_flags f
join public.call_reviews r on r.call_id = f.call_id
group by f.flag_key;

-- One-row roll-up for the tab header. count(distinct call_id) because a call can
-- carry several flags and must count once.
create or replace view public.review_summary
with (security_invoker = true) as
select
  count(distinct f.call_id) filter (
    where f.status in ('confirmed', 'needs_review')
  )                                                                      as flagged_calls,
  count(distinct f.call_id) filter (
    where f.status in ('confirmed', 'needs_review') and r.reviewed_at is null
  )                                                                      as unreviewed_calls,
  count(distinct f.call_id) filter (
    where f.status = 'needs_review'
  )                                                                      as needs_eyes_calls
from public.call_review_flags f
join public.call_reviews r on r.call_id = f.call_id;
