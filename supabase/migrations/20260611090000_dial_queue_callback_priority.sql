-- Prioritize scheduled callbacks ahead of cold leads in the auto-dialer.
--
-- Problem: the dial queue was ordered purely by `next_call_at`, and the tick
-- only takes the top 50 candidates per run. With thousands of cold
-- `ready_to_call` leads due (a large import) and an hourly call cap throttling
-- throughput, a scheduled callback — a time a prospect actually agreed to —
-- was buried behind ~2,700 cold leads and effectively never dialed.
--
-- Fix: expose a `dial_priority` on the queue (callbacks first), so the tick can
-- order by priority before `next_call_at`. A due callback now jumps to the
-- front and grabs the next available cap slot ahead of never-contacted leads.

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
  -- Appended last so `create or replace view` accepts it (it can only add
  -- trailing columns). 0 = scheduled callback (an agreed appointment) — always
  -- dialed first; 1 = everything else (cold / retry leads).
  (case when l.status = 'callback' then 0 else 1 end) as dial_priority
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
  'dial_priority orders scheduled callbacks (0) ahead of cold leads (1). '
  'Re-check caps in code at dial time before actually firing the call.';

grant select on public.dial_queue to authenticated;
