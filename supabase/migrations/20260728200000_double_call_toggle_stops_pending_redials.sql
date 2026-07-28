-- Turning double calling OFF must stop pending redials immediately.
--
-- THE GAP: `double_call_enabled` was read in exactly one place -- the retry
-- engine, at the moment call 1 ended -- and never again. Once a marker was
-- stamped on the lead, nothing downstream re-checked the campaign's opt-in:
-- dial_queue surfaced the redial and claim_lead_for_dial let it be claimed
-- purely on the strength of `redial_at` being inside its 10-minute window. So
-- an operator who unticked "Double call on voicemail" -- typically BECAUSE
-- they had just watched second calls go out and wanted them to stop -- kept
-- getting second calls for up to another 10 minutes, one per marker stamped
-- before the toggle flipped. Real phone calls to real businesses, after the
-- switch was off. Confirmed against prod: 4 leads were carrying live markers
-- at the moment the toggle was turned off on 2026-07-28.
--
-- THE FIX: make the campaign's opt-in part of what "a due redial" MEANS, in
-- both places that decide it. The marker alone is no longer sufficient --
-- redial_at must be inside its window AND the owning campaign must still have
-- double_call_enabled = true. Unticking the box now takes effect on the very
-- next tick: the queue stops surfacing those leads, the claim stops accepting
-- them, and each marker quietly ages out of its window exactly as an
-- unconsumed one always did.
--
-- Nothing needs cleaning up when the toggle flips, for the same reason the
-- original design needs no sweeper: call 1 already advanced the retry cycle
-- and wrote the lead's real next_call_at before the marker was ever stamped
-- (see 20260728120000_double_call.sql's header). A marker that never fires
-- costs nothing and strands nothing. Turning the feature back ON does NOT
-- resurrect old markers either -- the 10-minute window has long since closed
-- on them, which is what keeps "a voicemail yesterday" from being redialled
-- today.
--
-- Stale markers left on leads are still swept opportunistically by the next
-- ordinary claim (claim_lead_for_dial nulls redial_at on every successful
-- claim, either branch), unchanged from 20260728130000.

-- ---------------------------------------------------------------------------
-- 1. dial_queue: the redial branch now requires the campaign's opt-in.
--
-- create or replace view replaces the WHOLE object, so this is the complete
-- definition, reproduced verbatim from 20260728120000_double_call.sql with
-- exactly one kind of addition: `and c.double_call_enabled` appended to each
-- of the three copies of the redial-window test (is_redial_due, queue_order's
-- CASE, and the WHERE clause), each marked -- TOGGLE below. The DOUBLE CALL
-- comments from that migration are preserved so the reasoning behind the
-- ordering band and the two-sided window doesn't get lost.
--
-- The output column list is byte-for-byte unchanged (16 original columns, then
-- is_redial_due / redial_number_id / queue_order) -- create or replace view can
-- only APPEND columns, never rename or reorder them (Postgres 42P16), so those
-- 19 columns must stay in exactly this order.
--
-- OBLIGATION FOR THE NEXT CHANGE: create or replace view replaces the WHOLE
-- object, not a diff. Whoever next modifies dial_queue must reproduce this
-- ENTIRE definition (every DOUBLE CALL and TOGGLE addition included) in their
-- own migration, copied from the latest migration that defines it -- the same
-- way this one copied from 20260728120000_double_call.sql. A partial
-- `create or replace` silently deletes every column, branch, and comment it
-- doesn't repeat.
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
order by q.dial_priority, q.is_redial_due desc, q.queue_order nulls first;

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
  '(redial_number_id is preferred when still usable). Re-check caps in code.';

grant select on public.dial_queue to authenticated;

-- ---------------------------------------------------------------------------
-- 2. claim_lead_for_dial: the same gate, so the two stay mirrors.
--
-- The dialer only ever claims rows dial_queue handed it, so gating the view
-- alone would already stop the second calls. This is kept in lockstep anyway
-- because 20260728130000's header documents this WHERE as mirroring the
-- view's, and a claim that still accepts a redial the queue no longer offers
-- is a trap for whoever reads them side by side next.
--
-- The next_call_at CASE is gated identically, and that one is not merely
-- cosmetic: it exists to PRESERVE call 1's real schedule instead of stamping
-- the ordinary 2-minute lease. Left ungated, a claim won on the normal branch
-- by a lead that happened to still carry a live marker (feature since turned
-- off) would skip the lease and leave next_call_at untouched -- and if that
-- value were in the past, the lead would be re-dialled every tick. Gating both
-- copies together means a toggled-off campaign takes the ordinary path in
-- full.
--
-- Everything else -- the owner_campaign_id handling, the unconditional
-- clearing of redial_at / redial_number_id that both sweeps stale markers and
-- makes "consume the marker" atomic with "take the lead" -- is unchanged from
-- 20260728130000.
-- ---------------------------------------------------------------------------
create or replace function public.claim_lead_for_dial(
  in_lead_id uuid,
  in_campaign_id uuid
) returns boolean
language plpgsql
as $$
begin
  update public.leads
     set next_call_at = case
           when redial_at is not null
            and redial_at > now() - interval '10 minutes'
            and redial_at <= now()
            and exists (
              select 1 from public.campaigns dc
               where dc.id = in_campaign_id
                 and dc.double_call_enabled
            )
           then next_call_at
           else now() + interval '2 minutes'
         end,
         owner_campaign_id = coalesce(owner_campaign_id, in_campaign_id),
         redial_at = null,
         redial_number_id = null
   where id = in_lead_id
     and (
           next_call_at is null or next_call_at <= now()
        or (redial_at is not null
            and redial_at > now() - interval '10 minutes'
            and redial_at <= now()
            and exists (
              select 1 from public.campaigns dc
               where dc.id = in_campaign_id
                 and dc.double_call_enabled
            ))
     )
     and (owner_campaign_id is null or owner_campaign_id = in_campaign_id);
  return found;
end;
$$;

-- Only the service-role dialer calls this; a user-scoped client would get
-- permission denied on EXECUTE (intentional -- the claim is a server
-- operation). `create or replace function` preserves an existing grant on
-- its own, but re-issuing it here is harmless and keeps this migration
-- self-documenting.
grant execute on function public.claim_lead_for_dial(uuid, uuid) to service_role;
