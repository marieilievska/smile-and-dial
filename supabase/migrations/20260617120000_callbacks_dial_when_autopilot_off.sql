-- Scheduled callbacks dial even when a campaign's autopilot is OFF.
--
-- A callback is a time the prospect specifically agreed to. Autopilot OFF is
-- meant to pause COLD auto-dialing, not to drop agreed callbacks — yet the
-- dial_queue's `c.autopilot_enabled = true` join excluded the WHOLE campaign
-- (callbacks included) whenever autopilot was off, so agreed callbacks silently
-- stopped dialing. This mirrors the existing callback exemptions (the calling-
-- hours floor in 20260612170000 and the volume caps in 20260612180000):
-- callbacks bypass the pacing/automation gates because they're commitments,
-- while every safety rail still applies (campaign active, number attached, DNC,
-- the 08:00-21:00 local floor, owner concurrency, spend caps, in-flight guard).
--
-- Change vs 20260612170000: the campaign-join autopilot predicate becomes
--   (c.autopilot_enabled = true OR l.status = 'callback')
-- so an ACTIVE campaign with autopilot off still surfaces its DUE CALLBACKS
-- (but not its cold/retry leads). A paused/ended campaign still dials nothing —
-- `c.status = 'active'` is unchanged. Auto-dialer only: pre_call_check never
-- looked at autopilot, so manual Call Now is unaffected. View-only change.

create or replace view public.dial_queue
with (security_invoker = true)
as
select
  l.id as lead_id,
  l.owner_id,
  l.business_phone,
  l.timezone as lead_timezone,
  l.next_call_at,
  c.id as campaign_id,
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
join public.list_campaign_attachments lca
  on lca.list_id = l.list_id and lca.detached_at is null
join public.campaigns c
  on c.id = lca.campaign_id
  and c.status = 'active'
  -- Callbacks are agreed appointments — they dial regardless of autopilot.
  -- Cold/retry leads still require autopilot on.
  and (c.autopilot_enabled = true or l.status = 'callback')
where
  l.deleted_at is null
  and l.business_phone is not null
  and l.status in ('ready_to_call', 'callback')
  and (l.next_call_at is null or l.next_call_at <= now())
  and c.twilio_number_id is not null
  and not exists (
    select 1 from public.dnc_entries d
    where d.phone = l.business_phone
  )
  and (
    case
      when l.status = 'callback' then public.is_within_calling_hours(
        l.timezone, time '08:00:00', time '21:00:00'
      )
      else public.is_within_calling_hours(
        l.timezone, c.calling_hours_start, c.calling_hours_end
      )
    end
  );

comment on view public.dial_queue is
  'Leads currently eligible for the AUTO-dialer: ready, due, not on DNC, '
  'attached to an active campaign with a Twilio number. Cold/retry leads '
  'require autopilot on and dial inside the campaign calling window; scheduled '
  'callbacks dial regardless of autopilot (they are agreed appointments) inside '
  'the 08:00-21:00 local legal floor. dial_priority orders callbacks (0) ahead '
  'of cold leads (1). Re-check caps in code at dial time before firing.';

grant select on public.dial_queue to authenticated;
