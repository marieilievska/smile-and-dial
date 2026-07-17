-- Shared lists via lead ownership. Multiple active campaigns can dial one list;
-- each lead is worked by exactly one campaign (the first to dial it), recorded
-- in leads.owner_campaign_id and stamped atomically by claim_lead_for_dial.

-- 1. Ownership column. NULL = un-owned (shared pool). ON DELETE SET NULL returns
--    a deleted campaign's leads to the pool (mirrors calls.campaign_id).
alter table public.leads
  add column if not exists owner_campaign_id uuid
    references public.campaigns (id) on delete set null;

comment on column public.leads.owner_campaign_id is
  'The campaign that owns this lead for dialing. NULL = un-owned (shared pool). '
  'Stamped atomically at dial time by claim_lead_for_dial; sticky for the '
  'lead''s lifetime until released on list detach or owning-campaign delete.';

create index if not exists leads_owner_campaign_idx
  on public.leads (owner_campaign_id) where owner_campaign_id is not null;

-- 2. Allow a list to be actively attached to more than one campaign. This partial
--    unique index was the only DB-level block on sharing a list.
drop index if exists public.list_campaign_active_unique;

-- 3. The atomic dial-time claim, now ownership-aware. Wins iff the lead is still
--    due AND (un-owned OR already owned by this campaign); stamps the owner on a
--    first win. Postgres serializes the row write, so two campaigns reaching for
--    the same un-owned lead resolve to exactly one owner — the double-call
--    guarantee. Replaces the JS-side next_call_at CAS in src/lib/dialer/tick.ts.
create or replace function public.claim_lead_for_dial(
  in_lead_id uuid,
  in_campaign_id uuid
) returns boolean
language plpgsql
as $$
begin
  update public.leads
     set next_call_at = now() + interval '2 minutes',
         owner_campaign_id = coalesce(owner_campaign_id, in_campaign_id)
   where id = in_lead_id
     and (next_call_at is null or next_call_at <= now())
     and (owner_campaign_id is null or owner_campaign_id = in_campaign_id);
  return found;
end;
$$;

-- Only the service-role dialer calls this; a user-scoped client would get
-- permission denied on EXECUTE (intentional — the claim is a server operation).
grant execute on function public.claim_lead_for_dial(uuid, uuid) to service_role;

-- 4. dial_queue: re-declared verbatim from 20260713120000, with TWO changes:
--    (a) ownership predicate on the join — an owned lead is visible only to its
--        owner; (b) drop the `distinct on (lead_id)` collapse so an un-owned
--        lead surfaces to EVERY matching active campaign (first-available).
--    Same output columns (create or replace requires it).
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
  where
    l.deleted_at is null
    and l.business_phone is not null
    and l.status in ('ready_to_call', 'callback')
    and (l.next_call_at is null or l.next_call_at <= now())
    and c.twilio_number_id is not null
    and l.line_type is distinct from 'mobile'
    and not exists (
      select 1 from public.dnc_entries d
      where d.phone = l.business_phone
    )
    and (
      case
        when l.status = 'callback' then public.is_within_calling_hours(
          l.timezone, time '08:00:00', time '21:00:00', true
        )
        else public.is_within_calling_hours(
          l.timezone, c.calling_hours_start, c.calling_hours_end, false
        )
      end
    )
) q
order by q.dial_priority, q.next_call_at nulls first;

-- 5. One-time backfill: every already-dialed lead is owned by the campaign of
--    its most recent call, so in-progress leads stay glued to the campaign
--    already working them and can't be scooped when a list is later shared.
--    GUARD: only stamp when that campaign STILL currently targets the lead
--    (active list attachment / audience_search / smart list) — a lead whose
--    list was moved to another campaign since its last call is left un-owned so
--    its current campaign claims it fresh, never stranded. Guarded to only-null
--    owners; idempotent. Stable tiebreak (id desc) so re-runs are deterministic.
update public.leads l
   set owner_campaign_id = mr.campaign_id
  from (
    select distinct on (lead_id) lead_id, campaign_id
      from public.calls
     where campaign_id is not null
     order by lead_id, created_at desc, id desc
  ) mr
  join public.campaigns c on c.id = mr.campaign_id
 where mr.lead_id = l.id
   and l.owner_campaign_id is null
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
   );
