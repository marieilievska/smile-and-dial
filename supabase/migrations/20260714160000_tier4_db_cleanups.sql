-- Tier 4 low-risk DB cleanups from the 2026-07 audit.

-- 1. Covering indexes for foreign keys added after the 20260612220000 sweep.
--    Without them, campaign-scoped lookups and ON DELETE cascades fall back to
--    a scan as these tables grow. Additive and safe.
create index if not exists lead_campaign_summaries_campaign_id_idx
  on public.lead_campaign_summaries (campaign_id);
create index if not exists campaigns_smart_list_id_idx
  on public.campaigns (smart_list_id);

-- 2. Enable RLS on the two internal API bookkeeping tables. They are written
--    only by the service role (which bypasses RLS), so enabling RLS with NO
--    policies denies all REST access by the anon/authenticated roles — the same
--    pattern the webhook-event tables use. Fixes the "RLS Disabled in Public"
--    advisor for api_idempotency_keys (which caches API response bodies) and
--    api_rate_limits.
alter table public.api_idempotency_keys enable row level security;
alter table public.api_rate_limits enable row level security;

-- 3. Drop the dead hot_leads table. It was a seeded placeholder, superseded by
--    the live Hot Leads reporting view; it's referenced nowhere in code and has
--    no incoming foreign keys (hot_lead_dismissals references calls, not this).
drop table if exists public.hot_leads;

-- 4. Restore past-midnight ("wrap-around") handling to is_within_calling_hours.
--    The 4-arg version (weekend gate) used a plain BETWEEN, so a calling window
--    that crosses midnight (e.g. 21:00-06:00) evaluated to false at ALL times
--    and silently never dialed. Daytime windows (start <= end) are byte-for-byte
--    unchanged; this only adds correct handling for the wrap case, so it cannot
--    regress a normal window. (The earlier 3-arg overload is intentionally left
--    in place per 20260705120000 — harmless and unreferenced.)
create or replace function public.is_within_calling_hours(
  lead_timezone text,
  hours_start time,
  hours_end time,
  allow_weekends boolean
)
returns boolean
language sql
stable
as $$
  select
    (
      allow_weekends
      or extract(
        isodow from (now() at time zone coalesce(lead_timezone, 'America/New_York'))
      ) between 1 and 5
    )
    and (
      case
        when hours_start <= hours_end then
          (now() at time zone coalesce(lead_timezone, 'America/New_York'))::time
            between hours_start and hours_end
        else
          -- Window wraps past midnight (e.g. 21:00-06:00): in-window when the
          -- local time is at/after the start OR at/before the end.
          (now() at time zone coalesce(lead_timezone, 'America/New_York'))::time
            >= hours_start
          or (now() at time zone coalesce(lead_timezone, 'America/New_York'))::time
            <= hours_end
      end
    );
$$;
comment on function public.is_within_calling_hours(text, time, time, boolean) is
  'True when the lead''s local time is inside the calling-hours window AND '
  '(allow_weekends OR it is a weekday Mon-Fri). Handles windows that wrap past '
  'midnight (start > end). Callbacks pass allow_weekends=true so an agreed '
  'weekend appointment can dial; cold outreach passes false.';
