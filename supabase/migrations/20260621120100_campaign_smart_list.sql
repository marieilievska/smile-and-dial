-- Smart Lists R2: attach a smart list to a campaign + dial it.
--
-- campaigns.smart_list_id (nullable FK) attaches ONE smart list. The dial_queue
-- view gains a THIRD audience branch: a lead is in the queue if its list is
-- attached, OR the company-name filter matches, OR it is a member of the
-- campaign's attached smart list. Every safety gate (status, due, DNC, calling
-- hours, autopilot, per-lead dedup) is unchanged. on delete set null so deleting
-- a smart list simply detaches it instead of breaking the campaign.

alter table public.campaigns
  add column smart_list_id uuid
    references public.smart_lists (id) on delete set null;

comment on column public.campaigns.smart_list_id is
  'Optional attached smart list. When set, the campaign also targets every lead '
  'in smart_list_members for this list (in addition to attached lists and the '
  'company-name audience filter). NULL = no smart list attached.';

create or replace view public.dial_queue
with (security_invoker = true)
as
select distinct on (q.lead_id)
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
  q.dial_priority
from (
  select
    l.id as lead_id,
    l.owner_id,
    l.business_phone,
    l.timezone as lead_timezone,
    l.next_call_at,
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
    -- Callbacks are agreed appointments — they dial regardless of autopilot.
    -- Cold/retry leads still require autopilot on.
    and (c.autopilot_enabled = true or l.status = 'callback')
    -- Membership: attached list, OR company-name filter, OR smart-list member.
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
    )
) q
-- One row per lead = the double-call guard. Callbacks (dial_priority 0) win,
-- then the oldest campaign; campaign_id is the final stable tiebreak.
order by q.lead_id, q.dial_priority, q.campaign_created_at, q.campaign_id;

comment on view public.dial_queue is
  'Leads currently eligible for the AUTO-dialer: ready, due, not on DNC, '
  'attached to an active campaign with a Twilio number via an attached list, '
  'that campaign''s company-name audience filter, OR membership of the '
  'campaign''s attached smart list. Cold/retry leads require autopilot on and '
  'dial inside the campaign window; callbacks dial regardless of autopilot '
  'inside the 08:00-21:00 local floor. Collapsed to one row per lead (callbacks '
  'first, then oldest campaign) so a lead is dialed by exactly one campaign. '
  'dial_priority orders callbacks (0) ahead of cold (1). Re-check caps in code '
  'at dial time before firing.';

grant select on public.dial_queue to authenticated;
