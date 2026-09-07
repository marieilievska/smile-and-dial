-- Cause of Death: classify in SQL, and stop shipping 7,500 company names.
--
-- ---------------------------------------------------------------------------
-- Two problems, not one
--
-- fetchCauseOfDeath (src/lib/agent-analytics/report-data.ts) pages every call
-- in the 30-day window to build a per-lead outcome set, then chunk-loads all
-- ~7,500 of those leads' status/company, then classifies each in JavaScript.
--
-- But the query is only half of it. The view renders EVERY worked lead's
-- company name as a list item, grouped by cause. Measured on production
-- 2026-09-07: the tab takes ~5,000ms and returns **1,271 KB** -- twelve times
-- the Reporting dashboard's 108 KB. The lists sit inside collapsed <details>,
-- so nobody sees them without clicking, and the markup ships regardless.
--
-- Fixing only the query would have left a fast page that still shipped a
-- megabyte of hidden text. This does both: the aggregation AND the
-- classification happen here, and only a capped sample of names comes back.
--
-- ---------------------------------------------------------------------------
-- Why the classification moved into SQL too
--
-- The other three rewrites (20260906070000 / 080000 / 090000) kept their
-- classification in TypeScript and moved only the counting, because the counts
-- were small and the rules were the risky part. Here the opposite is true: the
-- OUTPUT is what is large. Returning one row per lead so the app could classify
-- them would have meant either 7,500 rows -- past PostgREST's 1,000-row cap --
-- or the same megabyte in a different shape.
--
-- So assignCause() is transcribed below as a CASE, in the same order, with the
-- same rule numbering in the comments. Order is the whole algorithm: the first
-- match wins, and moving one branch changes what a lead is counted as.
-- scripts/verify-cause-of-death-parity.mjs runs the JavaScript against this and
-- compares every cause count, every group total, every no-contact sub-reason
-- and the sampled company lists.
--
-- ---------------------------------------------------------------------------
-- The sample cap
--
-- `p_sample` (default 100) bounds the names returned per cause and per
-- no-contact sub-reason; `count` beside each list is always the true total, so
-- the UI can say "and 4,900 more" honestly rather than implying it showed
-- everything.
--
-- Ordered most-recently-called first, which is what the old insertion order
-- happened to be (the app iterated a Map built while paging calls created_at
-- DESC). Ties break on company then lead id so the sample is deterministic --
-- the old order had no tiebreak and could vary between two calls.
--
-- ---------------------------------------------------------------------------
-- Scoping
--
-- SECURITY INVOKER, like its three siblings: RLS scopes a member to their own
-- leads, and the service-role share surface still sees the workspace.
--
-- Leads are INNER JOINed and NOT filtered on deleted_at, matching the app: it
-- looked leads up by id and skipped any it could not find ("lead deleted since
-- the call"), but never excluded soft-deleted ones.
create or replace function public.cause_of_death_summary(
  p_since timestamptz,
  p_campaign_ids uuid[] default null,
  p_sample integer default 100
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with per_lead as (
    select
      c.lead_id,
      max(c.created_at) as last_call_at,
      bool_or(c.goal_met) as goal_met,
      -- One boolean per outcome the rules ask about, so the CASE below reads
      -- like assignCause's `has("…")` calls.
      bool_or(c.outcome = 'transferred_to_human') as has_transferred,
      bool_or(c.outcome = 'dnc') as has_dnc,
      bool_or(c.outcome = 'not_interested') as has_not_interested,
      bool_or(c.outcome in ('gatekeeper', 'gatekeeper_not_interested'))
        as has_gatekeeper,
      bool_or(c.outcome = 'invalid_number') as has_invalid_number,
      -- NO_CONTACT sub-reasons, in noContactReason()'s precedence order:
      -- a person > a machine > nobody picked up > an error.
      bool_or(c.outcome in (
        'hung_up_immediately', 'hung_up_later', 'call_back_later'
      )) as brushed_off,
      bool_or(c.outcome in ('voicemail', 'ai_receptionist')) as machine,
      bool_or(c.outcome in ('no_answer', 'busy', 'failed')) as no_pickup,
      bool_or(c.outcome in ('language_barrier', 'ai_error')) as errored,
      -- Newest objection wins, matching "first non-null in paged order" where
      -- the pages were created_at DESC. `id` breaks ties the app did not.
      (array_agg(c.objection_category order by c.created_at desc, c.id)
        filter (where c.objection_category is not null))[1] as objection_category,
      (array_agg(c.objection_specific order by c.created_at desc, c.id)
        filter (where c.objection_category is not null))[1] as objection_specific,
      (array_agg(c.objection_quote order by c.created_at desc, c.id)
        filter (where c.objection_category is not null))[1] as objection_quote
    from calls c
    where c.created_at >= p_since
      and c.lead_id is not null
      and (p_campaign_ids is null or c.campaign_id = any (p_campaign_ids))
    group by c.lead_id
  ),
  classified as (
    select
      p.lead_id,
      p.last_call_at,
      coalesce(l.company, '') as company,
      p.objection_category,
      p.objection_specific,
      p.objection_quote,
      -- assignCause(), branch for branch. FIRST MATCH WINS -- the order is the
      -- algorithm.
      case
        -- 1. Won / positive terminal status, or handed to a human closer.
        when p.goal_met
          or l.status in ('goal_met', 'sale', 'attended', 'closed')
          or p.has_transferred then 'won'
        -- 2. Hard terminal dispositions override an otherwise in-play status.
        when l.status = 'dnc' or p.has_dnc then 'opted_out'
        when p.has_not_interested then 'dm_said_no'
        -- 3. Still being worked or positively engaged (status encodes this).
        when l.status = 'callback' then 'callback_booked'
        when l.status in ('ready_to_call', 'scheduled', 'email_replied')
          then 'mid_follow_up'
        -- 4. Finished → the furthest stage actually reached.
        when l.decision_maker_reached is not true and p.has_gatekeeper
          then 'gatekeeper'
        when p.has_invalid_number then 'bad_number'
        else 'no_contact'
      end as cause,
      -- noContactReason(); only meaningful on a no_contact lead, and null when
      -- none of its outcomes qualify.
      case
        when p.brushed_off then 'brushed_off'
        when p.machine then 'machine'
        when p.no_pickup then 'no_pickup'
        when p.errored then 'error'
        else null
      end as no_contact_reason
    from per_lead p
    join leads l on l.id = p.lead_id
  ),
  -- Cause counts, and the capped, recency-ordered company sample per cause.
  by_cause as (
    select
      cause,
      count(*)::integer as n,
      (
        array_agg(company order by last_call_at desc, company, lead_id)
      )[1:greatest(p_sample, 0)] as sample
    from classified
    group by cause
  ),
  by_reason as (
    select
      no_contact_reason as reason,
      count(*)::integer as n,
      (
        array_agg(company order by last_call_at desc, company, lead_id)
      )[1:greatest(p_sample, 0)] as sample
    from classified
    where cause = 'no_contact' and no_contact_reason is not null
    group by no_contact_reason
  ),
  -- Objections, for the two causes that carry a why-breakdown. Bounded by
  -- nature (only leads that reached a person have one) so these are not capped.
  objections as (
    select
      cause,
      jsonb_agg(
        jsonb_build_object(
          'leadId', lead_id,
          'company', company,
          'category', objection_category,
          'specific', objection_specific,
          'quote', objection_quote
        )
        order by last_call_at desc, lead_id
      ) as rows
    from classified
    where cause in ('dm_said_no', 'gatekeeper')
      and objection_category is not null
    group by cause
  )
  select jsonb_build_object(
    'total', (select count(*)::integer from classified),
    'causes', coalesce(
      (
        select jsonb_object_agg(
          cause,
          jsonb_build_object('count', n, 'sample', to_jsonb(sample))
        )
        from by_cause
      ),
      '{}'::jsonb
    ),
    'noContact', coalesce(
      (
        select jsonb_object_agg(
          reason,
          jsonb_build_object('count', n, 'sample', to_jsonb(sample))
        )
        from by_reason
      ),
      '{}'::jsonb
    ),
    'objections', coalesce(
      (select jsonb_object_agg(cause, rows) from objections),
      '{}'::jsonb
    )
  );
$$;

comment on function public.cause_of_death_summary(
  timestamptz, uuid[], integer
) is
  'Cause-of-death rollup for the Reporting tab: per-cause counts with a capped, '
  'recency-ordered company sample, the no-contact sub-reason breakdown, and the '
  'objection rows for the two causes that carry one. Replaces paging ~8k calls '
  'plus ~7.5k leads into JavaScript AND shipping every company name to the '
  'browser (20260907100000). assignCause() is transcribed here branch for '
  'branch -- first match wins, so the order IS the algorithm. SECURITY INVOKER.';

grant execute on function public.cause_of_death_summary(
  timestamptz, uuid[], integer
) to authenticated;
