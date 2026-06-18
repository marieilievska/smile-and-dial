-- Campaign audience filters: target leads by company-name text, not just lists.
--
-- Problem: a lead belongs to exactly one list, so when a second upload overlaps
-- an earlier one the duplicates are skipped and never join the new list — and
-- the dialer, which picks leads by their single home list, never calls them.
--
-- Fix: campaigns gain an optional `audience_search`. When set, the campaign also
-- targets every lead (same owner) whose company name ILIKE-contains that text,
-- regardless of which list the lead lives in. List-based targeting is unchanged.
--
-- Because a lead can now match more than one campaign (a filter on one, a list
-- on another), the rebuilt view collapses to ONE row per lead — the double-call
-- guard the old one-lead-one-list rule used to provide for free. Winner per
-- lead: scheduled callbacks first, then the oldest campaign.
--
-- Output columns and every safety gate (status, due, DNC, calling hours, the
-- callback 08:00-21:00 floor, autopilot rule, active campaign + Twilio number)
-- are identical to 20260617120000 — only the membership join and the per-lead
-- dedup change. tick.ts and pre_call_check are untouched.

alter table public.campaigns
  add column audience_search text;

comment on column public.campaigns.audience_search is
  'Optional company-name filter. When set, the campaign also targets every '
  'lead (same owner) whose company name ILIKE-contains this text, regardless '
  'of list membership. NULL = list-only targeting.';

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
    -- Membership: the lead's list is attached to this campaign, OR the
    -- campaign's company-name filter matches the lead.
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
  'attached to an active campaign with a Twilio number OR matching that '
  'campaign''s company-name audience filter. Cold/retry leads require autopilot '
  'on and dial inside the campaign window; callbacks dial regardless of '
  'autopilot inside the 08:00-21:00 local floor. Collapsed to one row per lead '
  '(callbacks first, then oldest campaign) so a lead is dialed by exactly one '
  'campaign. dial_priority orders callbacks (0) ahead of cold (1). Re-check '
  'caps in code at dial time before firing.';

grant select on public.dial_queue to authenticated;
