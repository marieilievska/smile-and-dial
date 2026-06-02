-- Autopilot toggle: separate the AUTO-dialer from manual Call Now.
--
-- Until now a campaign being `status = 'active'` drove both the background
-- auto-dialer AND manual Call Now, so there was no way to make one-off manual
-- calls without the AI also dialing the whole list. Add `autopilot_enabled`:
-- the dial_queue (auto-dialer) requires it true; manual Call Now goes through
-- pre_call_check, which does NOT look at it, so manual works either way.
--
-- Defaults true so existing campaigns keep auto-dialing exactly as before.

alter table public.campaigns
  add column if not exists autopilot_enabled boolean not null default true;

comment on column public.campaigns.autopilot_enabled is
  'When false, the background auto-dialer skips this campaign (it''s excluded '
  'from dial_queue). Manual Call Now still works while the campaign is active.';

-- Recreate the dial queue with the autopilot gate. Identical to the prior
-- definition except for the added `c.autopilot_enabled` predicate.
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
  c.monthly_spend_cap
from public.leads l
join public.list_campaign_attachments lca
  on lca.list_id = l.list_id and lca.detached_at is null
join public.campaigns c
  on c.id = lca.campaign_id
  and c.status = 'active'
  and c.autopilot_enabled = true
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
  and public.is_within_calling_hours(
    l.timezone, c.calling_hours_start, c.calling_hours_end
  );

comment on view public.dial_queue is
  'Leads currently eligible for the AUTO-dialer: ready, due, not on DNC, '
  'attached to an active campaign with autopilot on, inside calling hours. '
  'Re-check caps in code at dial time before actually firing the call.';

grant select on public.dial_queue to authenticated;
