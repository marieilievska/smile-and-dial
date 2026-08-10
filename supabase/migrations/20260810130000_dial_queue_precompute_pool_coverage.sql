-- ---------------------------------------------------------------------------
-- dial_queue: make local_match_rank scale to a large number pool.
--
-- REGRESSION: local_match_rank (added 20260729120200, reordered 20260729120300)
-- computed, FOR EVERY due lead, two correlated EXISTS over the campaign's pool
-- numbers — the "same area code" one and, worse, a "same state" one that joins
-- each pool number to nanp_area_codes. That is O(due_leads x pool_size). It sat
-- under the 8s statement timeout at ~8 numbers; growing the pool to ~62 pushed
-- it over, so `select from dial_queue` began timing out (57014). The dialer
-- reads dial_queue every tick, so a timeout returned ZERO candidates and
-- outbound dialing silently stopped (inbound, being webhook-driven, kept going).
--
-- FIX: precompute each campaign's dialable coverage ONCE — the set of area codes
-- its usable numbers cover (`pool`) and the set of US states they cover
-- (`pool_states`) — as materialized CTEs, then rank each lead with a cheap
-- semi-join against those tiny sets instead of re-scanning the pool per lead.
-- Behaviour is identical: the same gates (released_at / pool_status /
-- flagged_for_rotation / elevenlabs_phone_number_id / rested_until) decide which
-- numbers count, and the 0/1/2 result is unchanged. ONLY local_match_rank's two
-- EXISTS change; every other column, the WHERE (incl. the pool gate), and the
-- ORDER BY are reproduced verbatim from 20260729120300_dial_queue_first_call_gate.
--
-- Also adds a partial index for the eligible-lead scan (status + next_call_at),
-- which was a ~2s seq scan on its own.
--
-- OBLIGATION FOR THE NEXT CHANGE: create or replace view replaces the WHOLE
-- object. Whoever next modifies dial_queue must reproduce this ENTIRE definition.
-- ---------------------------------------------------------------------------

create index if not exists idx_leads_dial_eligible
  on public.leads (owner_id, next_call_at)
  where deleted_at is null
    and business_phone is not null
    and status in ('ready_to_call', 'callback')
    and line_type is distinct from 'mobile';

create or replace view public.dial_queue
with (security_invoker = true)
as
with pool as materialized (
  -- Usable pool numbers per campaign, mirroring selectPoolNumber's gates
  -- INCLUDING rested_until. Precomputed once so local_match_rank is a semi-join
  -- against a tiny set, not a per-lead scan of the whole pool.
  select
    tn.attached_campaign_id as campaign_id,
    tn.area_code
  from public.twilio_numbers tn
  where tn.released_at is null
    and tn.pool_status = 'active'
    and tn.flagged_for_rotation = false
    and tn.elevenlabs_phone_number_id is not null
    and (tn.rested_until is null or tn.rested_until <= now())
),
pool_states as materialized (
  -- The US states each campaign can dial locally (its usable numbers' area
  -- codes -> states), precomputed once.
  select distinct p.campaign_id, na.state
  from pool p
  join public.nanp_area_codes na on na.area_code = p.area_code
  where na.state is not null
)
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
  q.is_redial_due,
  q.redial_number_id,
  q.queue_order,
  q.dest_rank,
  q.local_match_rank
from (
  select
    l.id as lead_id,
    l.owner_id,
    l.business_phone,
    l.timezone as lead_timezone,
    l.next_call_at,
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
    -- LOCAL MATCH: 0 = United States, 1 = Canada or unparseable.
    (case
       when coalesce(l.retry_counter, 0) <> 0 then 0
       when nl.country = 'US' then 0
       else 1
     end) as dest_rank,
    -- LOCAL MATCH: 0 = campaign has a usable number in this lead's area code,
    -- 1 = one in the same state, 2 = neither. Now a semi-join against the
    -- precomputed per-campaign coverage sets (pool / pool_states) instead of a
    -- correlated scan of the pool per lead.
    (case
       when coalesce(l.retry_counter, 0) <> 0 then 0
       when exists (
         select 1 from pool p
          where p.campaign_id = c.id
            and p.area_code = nl.area_code
       ) then 0
       when nl.state is not null and exists (
         select 1 from pool_states ps
          where ps.campaign_id = c.id
            and ps.state = nl.state
       ) then 1
       else 2
     end) as local_match_rank
  from public.leads l
  join public.campaigns c
    on c.owner_id = l.owner_id
    and c.status = 'active'
    and (c.autopilot_enabled = true or l.status = 'callback')
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
  left join public.nanp_area_codes nl
    on nl.area_code = substring(l.business_phone from 3 for 3)
  where
    l.deleted_at is null
    and l.business_phone is not null
    and l.status in ('ready_to_call', 'callback')
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
    and l.line_type is distinct from 'mobile'
    and not exists (
      select 1 from public.dnc_entries d
      where d.phone = l.business_phone
    )
    and (
      l.status = 'callback'
      or public.is_within_calling_hours(
        l.timezone, c.calling_hours_start, c.calling_hours_end, false
      )
    )
) q
order by q.dial_priority,
  q.is_redial_due desc,
  q.dest_rank,
  q.local_match_rank,
  q.queue_order nulls first;

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
  'puts US ahead of Canada and local_match_rank (a semi-join against each '
  'campaign''s precomputed pool coverage) puts leads whose area code or state '
  'the campaign can dial locally ahead of the rest. Re-check caps in code.';

grant select on public.dial_queue to authenticated;
