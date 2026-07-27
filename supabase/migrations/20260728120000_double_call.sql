-- Double calling (schema only): when a voicemail lands on an opted-in
-- campaign at retry position 0 or 2, a later task's retry engine redials the
-- same lead from the same number within a short window instead of waiting
-- for the lead's normal next_call_at. This migration adds the columns and
-- the dial_queue eligibility branch; no application code reads them yet.
--
-- WHY the marker is purely additive, needing no cleanup path: the retry
-- engine advances the lead's retry cycle exactly as it does today --
-- next_call_at moves 2d/2d/15d out, retry_position/retry_counter advance --
-- and only then, in that same update, stamps redial_at/redial_number_id if
-- the redial conditions hold. The lead is fully and correctly scheduled the
-- instant call 1 ends, before the redial is even considered.
--
-- That ordering is what makes an unfired redial free. If the redial can't
-- place -- outside calling hours, campaign paused, caps hit, pool empty,
-- whatever -- redial_at simply ages past the 10-minute window dial_queue
-- checks below and becomes inert. The lead was never depending on it:
-- next_call_at already points at the correct next attempt, so there is
-- nothing to roll back and nothing to sweep. Contrast with the rejected
-- alternative (defer the cycle advance until the redial lands): that leaves a
-- lead stuck past-due, still flagged for a redial that will never come, a
-- cycle step behind, whenever the redial fails to fire -- silently and
-- permanently.
--
-- See docs/superpowers/specs/2026-07-27-double-call-design.md for the full
-- design and the alternatives considered.

-- ---------------------------------------------------------------------------
-- 1. Schema: campaign opt-in, the lead's redial marker, the call's redial flag.
-- ---------------------------------------------------------------------------
alter table public.campaigns
  add column if not exists double_call_enabled boolean not null default false;

comment on column public.campaigns.double_call_enabled is
  'When true, a voicemail at retry position 0 or 2 schedules an immediate '
  'redial of the same lead from the same number. Off by default.';

alter table public.leads
  add column if not exists redial_at timestamptz,
  add column if not exists redial_number_id uuid
    references public.twilio_numbers (id) on delete set null;

comment on column public.leads.redial_at is
  'A pending double-call redial, valid for 10 minutes from this timestamp. '
  'Left in place once stale (the queue ignores it); the next qualifying '
  'voicemail overwrites it. There is no sweeper and none is needed.';

alter table public.calls
  add column if not exists is_redial boolean not null default false;

comment on column public.calls.is_redial is
  'True when this call is the second half of a double-call pair. Such a call '
  'never advances the retry cycle (call 1 already did) and never schedules '
  'another redial.';

-- No index on leads.redial_at: its only consumer is the OR branch in
-- dial_queue's WHERE below, and the other side of that OR (next_call_at) is
-- unindexed. Postgres can only use an index across a top-level OR via
-- BitmapOr, which requires an indexable path for EVERY branch, so this
-- predicate is never eligible to use one regardless -- an index here would be
-- pure write amplification on a hot table with no matching read. Nothing else
-- filters on redial_at (the retry engine writes by id, and there is no
-- sweeper by design).

-- ---------------------------------------------------------------------------
-- 2. dial_queue: add the redial eligibility branch.
--
-- create or replace view replaces the WHOLE object, so this is the complete
-- definition, reproduced verbatim from 20260721120000_restore_dialer_rules.sql
-- with exactly three additions, each marked -- DOUBLE CALL below:
--   (a) is_redial_due / redial_number_id / queue_order columns, in both the
--       inner subquery and the outer select
--   (b) the WHERE clause's due check gains a second branch: also-due when
--       there is an unconsumed redial marker inside its 10-minute window
--       (bounded on BOTH sides -- see the WHERE clause comment for why)
--   (c) ORDER BY gains an `is_redial_due desc` band ahead of queue_order, so
--       a due redial sorts to the FRONT of its dial_priority tier. This is
--       not optional polish: queue_order alone sorts a due redial (redial_at,
--       seconds old) BEHIND every backlog lead (next_call_at, often days
--       old) under plain ascending order, so without the band the redial
--       would sort last, past the dialer's 50-row read, and the feature
--       would never fire. queue_order remains the tiebreak within a band --
--       it equals next_call_at for every non-redial row, so cold-lead
--       ordering is unchanged.
-- Everything else -- joins, shared-list ownership, list/audience/smart-list
-- targeting, the pool gate, the mobile lock, the DNC check, the calling-hours
-- check -- is unchanged.
--
-- OBLIGATION FOR THE NEXT CHANGE: create or replace view replaces the WHOLE
-- object, not a diff. Whoever next modifies dial_queue must reproduce this
-- ENTIRE definition (all three DOUBLE CALL additions included) in their own
-- migration, copied from the latest migration that defines it -- the same
-- way this one copied from 20260721120000_restore_dialer_rules.sql. A
-- partial `create or replace` silently deletes every column, branch, and
-- comment it doesn't repeat.
-- ---------------------------------------------------------------------------
create or replace view public.dial_queue
with (security_invoker = true)
as
select
  q.lead_id,
  q.owner_id,
  q.business_phone,
  q.lead_timezone,
  q.next_call_at,
  q.campaign_id,
  q.agent_id,
  q.twilio_number_id,
  q.calling_hours_start,
  q.calling_hours_end,
  q.calls_per_hour_cap,
  q.calls_per_day_cap,
  q.concurrency_cap_per_user,
  q.daily_spend_cap,
  q.monthly_spend_cap,
  q.dial_priority,
  -- DOUBLE CALL: appended after dial_priority, not interleaved with the
  -- columns above -- create or replace view can only APPEND new columns at
  -- the end of the output list; it cannot rename or reorder an existing one
  -- (Postgres 42P16). The 16 columns above must stay in exactly this order.
  q.is_redial_due,
  q.redial_number_id,
  q.queue_order
from (
  select
    l.id as lead_id,
    l.owner_id,
    l.business_phone,
    l.timezone as lead_timezone,
    l.next_call_at,
    -- DOUBLE CALL: is_redial_due drives the `is_redial_due desc` band in
    -- ORDER BY below -- that band, not queue_order, is what actually sorts a
    -- due redial to the front of its tier (queue_order is only the tiebreak
    -- within a band; see the ORDER BY comment). The upper bound
    -- (redial_at <= now()) matters even though redial_at is always stamped
    -- in the past by the app: it is a Node-server timestamp compared against
    -- the database's now(), there is deliberately no sweeper, so a
    -- future-stamped value -- clock skew, a manual fix, a backfill -- would
    -- otherwise satisfy the lower bound forever and pin the lead in the
    -- queue indefinitely.
    (
      l.redial_at is not null
      and l.redial_at > now() - interval '10 minutes'
      and l.redial_at <= now()
    ) as is_redial_due,
    l.redial_number_id,
    coalesce(
      case
        when l.redial_at is not null
          and l.redial_at > now() - interval '10 minutes'
          and l.redial_at <= now()
        then l.redial_at
      end,
      l.next_call_at
    ) as queue_order,
    c.id as campaign_id,
    c.created_at as campaign_created_at,
    c.agent_id,
    c.twilio_number_id,
    c.calling_hours_start,
    c.calling_hours_end,
    c.calls_per_hour_cap,
    c.calls_per_day_cap,
    c.concurrency_cap_per_user,
    c.daily_spend_cap,
    c.monthly_spend_cap,
    (case when l.status = 'callback' then 0 else 1 end) as dial_priority
  from public.leads l
  join public.campaigns c
    on c.owner_id = l.owner_id
    and c.status = 'active'
    -- Autopilot pauses COLD outreach only. A scheduled callback is a promise to
    -- a person, so it still runs with autopilot off.
    and (c.autopilot_enabled = true or l.status = 'callback')
    -- Shared lists: a lead belongs to the campaign that first dialled it, and
    -- no other campaign may touch it until that campaign releases it (which
    -- happens when the list is detached -- see list-attachments-actions.ts).
    and (l.owner_campaign_id is null or l.owner_campaign_id = c.id)
    and (
      exists (
        select 1 from public.list_campaign_attachments lca
        where lca.campaign_id = c.id
          and lca.list_id = l.list_id
          and lca.detached_at is null
      )
      or (
        c.audience_search is not null
        and l.company is not null
        and l.company ilike '%' || c.audience_search || '%'
      )
      or (
        c.smart_list_id is not null
        and exists (
          select 1 from public.smart_list_members slm
          where slm.smart_list_id = c.smart_list_id
            and slm.lead_id = l.id
        )
      )
    )
  where
    l.deleted_at is null
    and l.business_phone is not null
    and l.status in ('ready_to_call', 'callback')
    -- DOUBLE CALL: due either the normal way, or because there is an
    -- unconsumed redial marker inside its 10-minute window. The retry cycle
    -- already advanced on call 1, so next_call_at alone would miss it. The
    -- upper bound guards against a future-stamped redial_at (clock skew, a
    -- manual fix, a backfill) pinning the lead in the queue forever -- there
    -- is no sweeper, so this predicate is the only thing that ever expires it.
    and (
          (l.next_call_at is null or l.next_call_at <= now())
       or (
            l.redial_at is not null
            and l.redial_at > now() - interval '10 minutes'
            and l.redial_at <= now()
          )
    )
    -- Pool gate (the number itself is chosen at placement by selectPoolNumber).
    and exists (
      select 1 from public.twilio_numbers tn
       where tn.attached_campaign_id = c.id
         and tn.released_at is null
         and tn.pool_status = 'active'
         and tn.flagged_for_rotation = false
         and tn.elevenlabs_phone_number_id is not null
    )
    -- Never AI-dial a mobile (mirrors pre_call_check; human dialling bypasses).
    and l.line_type is distinct from 'mobile'
    and not exists (
      select 1 from public.dnc_entries d
      where d.phone = l.business_phone
    )
    -- Scheduled callbacks run whenever they were booked for -- no window, no
    -- weekday gate. Cold outreach: campaign hours, weekdays only.
    and (
      l.status = 'callback'
      or public.is_within_calling_hours(
        l.timezone, c.calling_hours_start, c.calling_hours_end, false
      )
    )
) q
-- DOUBLE CALL: was `order by q.dial_priority, q.next_call_at nulls first;`.
-- queue_order ALONE is not enough to sort a due redial first -- it equals
-- next_call_at for a normal row but redial_at (seconds old) for a due
-- redial, and under plain ascending order that redial_at sorts AFTER a
-- backlog lead's next_call_at (often days old). Without a separate band, a
-- due redial would sort behind ~33k due leads, past the dialer's 50-row
-- read, and never fire inside its 10-minute window. `is_redial_due desc`
-- adds that band: every due redial in a dial_priority tier sorts before
-- every non-redial row in that tier. queue_order only breaks ties within a
-- band, and is a no-op for non-redial rows (where it equals next_call_at),
-- so cold-lead ordering is unchanged.
order by q.dial_priority, q.is_redial_due desc, q.queue_order nulls first;

comment on view public.dial_queue is
  'Leads eligible for the AUTO-dialer: ready, due, not on DNC, not a mobile, '
  'owned by this campaign (or unowned), targeted by an attached list / audience '
  'search / smart list, on an active campaign with >=1 usable pool number. '
  'Autopilot gates COLD leads only -- scheduled callbacks run regardless, at '
  'whatever time they were booked for. A lead is also due when is_redial_due '
  'is true (an unconsumed double-call redial marker inside its 10-minute '
  'window, redial_at bounded on both sides so a future timestamp cannot pin '
  'it forever). dial_priority orders callbacks (0) ahead of cold leads (1); '
  'within a tier, is_redial_due desc puts a due redial ahead of leads merely '
  'waiting on next_call_at -- the retry cycle already advanced on call 1, so '
  'next_call_at alone would sort a redial days behind. queue_order (redial_at '
  'when due, else next_call_at) is only the tiebreak within that band. The '
  'specific number is chosen at placement by selectPoolNumber '
  '(redial_number_id is preferred when still usable). Re-check caps in code.';

grant select on public.dial_queue to authenticated;
