-- Number pool: gate the auto-dial queue on the campaign having >=1 usable POOL
-- number (the specific number is chosen at placement by selectPoolNumber).
-- Re-creates dial_queue from 20260611090000_dial_queue_callback_priority.sql,
-- changing ONLY the number filter (single-number -> pool-existence).
--
-- We deliberately KEEP c.twilio_number_id in the projection for now: the
-- currently-deployed dialer still selects it, so dropping it here would break
-- live dialing during the deploy window. The new code simply ignores it. A later
-- phase can drop the column once every deploy reads from the pool. (See
-- feedback_migration_sequencing: never drop a projected column before the code
-- that stopped reading it has shipped.)

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
  and c.autopilot_enabled = true
where
  l.deleted_at is null
  and l.business_phone is not null
  and l.status in ('ready_to_call', 'callback')
  and (l.next_call_at is null or l.next_call_at <= now())
  and exists (
    select 1 from public.twilio_numbers tn
     where tn.attached_campaign_id = c.id
       and tn.released_at is null
       and tn.pool_status = 'active'
       and tn.flagged_for_rotation = false
       and tn.elevenlabs_phone_number_id is not null
  )
  and not exists (
    select 1 from public.dnc_entries d where d.phone = l.business_phone
  )
  and public.is_within_calling_hours(
    l.timezone, c.calling_hours_start, c.calling_hours_end
  );

comment on view public.dial_queue is
  'Leads eligible for the AUTO-dialer: ready, due, not on DNC, in calling hours, '
  'attached to an active autopilot campaign that has >=1 usable pool number. '
  'dial_priority orders callbacks (0) ahead of cold leads (1). The specific '
  'number is chosen at placement by selectPoolNumber. Re-check caps in code.';

grant select on public.dial_queue to authenticated;
