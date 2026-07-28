-- ---------------------------------------------------------------------------
-- dial_queue: rank cold leads by how local the campaign's available numbers
-- are to them, and put US ahead of Canada.
--
-- Reproduced verbatim from 20260728200000_double_call_toggle_stops_pending_redials.sql
-- with exactly two kinds of addition, each marked -- LOCAL MATCH below:
--   1. a left join to public.nanp_area_codes for the LEAD's geography, plus two
--      new output columns dest_rank and local_match_rank (appended last -- see
--      the 42P16 note at the column list);
--   2. two new trailing ORDER BY keys.
-- Every DOUBLE CALL and TOGGLE branch and comment from that migration is
-- preserved unchanged.
--
-- NOTE: the ORDER BY here is only advisory for the dialer. PostgREST applies
-- the CLIENT's .order() calls in place of a view's own ORDER BY, so
-- src/lib/dialer/tick.ts and src/lib/dialer/queue.ts must both pass dest_rank
-- and local_match_rank or this ranking is computed and then ignored.
--
-- OBLIGATION FOR THE NEXT CHANGE: unchanged from the previous migration --
-- create or replace view replaces the WHOLE object, not a diff. Whoever next
-- modifies dial_queue must reproduce this ENTIRE definition, including the
-- LOCAL MATCH additions, copied from the latest migration that defines it. A
-- partial create or replace silently deletes every column, branch, and comment
-- it doesn't repeat.
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
  q.queue_order,
  -- LOCAL MATCH: appended last -- create or replace view cannot reorder or
  -- rename the 19 columns above (Postgres 42P16).
  q.dest_rank,
  q.local_match_rank
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
    -- TOGGLE: and the campaign must STILL be opted in. Without this, a marker
    -- stamped seconds before the operator unticked the box would still be
    -- dialled, up to 10 minutes after the feature was turned off.
    (
      l.redial_at is not null
      and l.redial_at > now() - interval '10 minutes'
      and l.redial_at <= now()
      and c.double_call_enabled
    ) as is_redial_due,
    l.redial_number_id,
    coalesce(
      case
        when l.redial_at is not null
          and l.redial_at > now() - interval '10 minutes'
          and l.redial_at <= now()
          and c.double_call_enabled -- TOGGLE
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
    (case when l.status = 'callback' then 0 else 1 end) as dial_priority,
    -- LOCAL MATCH: 0 = United States, 1 = Canada or unparseable. Country
    -- outranks the match tier so buying Canadian numbers can never promote
    -- Canadian leads ahead of US ones.
    (case when nl.country = 'US' then 0 else 1 end) as dest_rank,
    -- LOCAL MATCH: 0 = the campaign has a dialable number in this lead's own
    -- area code, 1 = one in the same state, 2 = neither. The availability test
    -- mirrors selectPoolNumber's gates INCLUDING rested_until, so a resting
    -- number cannot pull its leads to the front of the queue.
    (case
       when exists (
         select 1 from public.twilio_numbers tn
          where tn.attached_campaign_id = c.id
            and tn.released_at is null
            and tn.pool_status = 'active'
            and tn.flagged_for_rotation = false
            and tn.elevenlabs_phone_number_id is not null
            and (tn.rested_until is null or tn.rested_until <= now())
            and tn.area_code = nl.area_code
       ) then 0
       when nl.state is not null and exists (
         select 1 from public.twilio_numbers tn
           join public.nanp_area_codes na on na.area_code = tn.area_code
          where tn.attached_campaign_id = c.id
            and tn.released_at is null
            and tn.pool_status = 'active'
            and tn.flagged_for_rotation = false
            and tn.elevenlabs_phone_number_id is not null
            and (tn.rested_until is null or tn.rested_until <= now())
            and na.state = nl.state
       ) then 1
       else 2
     end) as local_match_rank
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
  -- LOCAL MATCH: the LEAD's geography. Left join so a lead whose phone is not a
  -- parseable +1 NANP number (or is toll-free, which the table deliberately
  -- omits) still appears -- it simply ranks as non-US with no local match.
  left join public.nanp_area_codes nl
    on nl.area_code = substring(l.business_phone from 3 for 3)
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
    -- TOGGLE: the redial branch also requires the campaign's live opt-in, so
    -- unticking the box stops pending second calls on the very next tick
    -- instead of leaking up to 10 more minutes of them.
    and (
          (l.next_call_at is null or l.next_call_at <= now())
       or (
            l.redial_at is not null
            and l.redial_at > now() - interval '10 minutes'
            and l.redial_at <= now()
            and c.double_call_enabled
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
-- LOCAL MATCH: two keys APPENDED after queue_order, deliberately not before
-- it. Every never-scheduled lead has next_call_at null, so queue_order is null
-- and they all TIE on that key -- which makes these two the effective sort for
-- exactly the first-call population this is meant to reorder. Rows that already
-- carry a timestamp (retries, callbacks, and cold leads pre_call_check bumped
-- by 5 minutes) keep their existing time-ordered position, with these acting
-- only as a rare tiebreak. Placing them BEFORE queue_order would instead
-- reorder retries and drag matched leads repeatedly ahead of unmatched ones.
order by
  q.dial_priority,
  q.is_redial_due desc,
  q.queue_order nulls first,
  q.dest_rank,
  q.local_match_rank;

comment on view public.dial_queue is
  'Leads eligible for the AUTO-dialer: ready, due, not on DNC, not a mobile, '
  'owned by this campaign (or unowned), targeted by an attached list / audience '
  'search / smart list, on an active campaign with >=1 usable pool number. '
  'Autopilot gates COLD leads only -- scheduled callbacks run regardless, at '
  'whatever time they were booked for. A lead is also due when is_redial_due '
  'is true: an unconsumed double-call redial marker inside its 10-minute '
  'window (redial_at bounded on both sides so a future timestamp cannot pin '
  'it forever) on a campaign whose double_call_enabled is STILL true, so '
  'turning the toggle off drops pending redials on the next tick. '
  'dial_priority orders callbacks (0) ahead of cold leads (1); '
  'within a tier, is_redial_due desc puts a due redial ahead of leads merely '
  'waiting on next_call_at -- the retry cycle already advanced on call 1, so '
  'next_call_at alone would sort a redial days behind. queue_order (redial_at '
  'when due, else next_call_at) is only the tiebreak within that band. The '
  'specific number is chosen at placement by selectPoolNumber '
  '(redial_number_id is preferred when still usable). '
  'Among never-scheduled leads (queue_order null, so all tied), dest_rank '
  'puts US ahead of Canada and local_match_rank puts leads whose area code '
  'or state the campaign can dial locally ahead of the rest. '
  'Re-check caps in code.';

grant select on public.dial_queue to authenticated;
