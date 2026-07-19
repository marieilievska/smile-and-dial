-- Number pool (Phase 1): columns to support a per-campaign pool of numbers with
-- per-number daily caps, warm-up, and temporary rest. Additive + backward
-- compatible: an existing campaign's single attached number becomes a pool of 1.

alter table public.twilio_numbers
  add column if not exists area_code text,
  add column if not exists pool_status text not null default 'active',
  add column if not exists rested_until timestamptz,
  add column if not exists warmup_started_at timestamptz,
  add column if not exists daily_cap_override int;

alter table public.twilio_numbers
  drop constraint if exists twilio_numbers_pool_status_check;
alter table public.twilio_numbers
  add constraint twilio_numbers_pool_status_check
  check (pool_status in ('active', 'retired'));

-- Backfill: area code from the E.164 number; warm-up anchored at purchase (so
-- existing numbers are already "warm", full cap immediately).
update public.twilio_numbers
   set area_code = substring(phone_number from '^\+1(\d{3})')
 where area_code is null and phone_number ~ '^\+1\d{10}$';
update public.twilio_numbers
   set warmup_started_at = coalesce(warmup_started_at, purchased_at);

create index if not exists twilio_numbers_pool_idx
  on public.twilio_numbers (attached_campaign_id, pool_status);
create index if not exists twilio_numbers_pool_area_idx
  on public.twilio_numbers (attached_campaign_id, area_code);

-- Single-row config blob (mirrors best_time_heatmap). Defaults chosen for
-- reputation-safe high-volume dialing.
alter table public.app_settings
  add column if not exists number_pool_settings jsonb not null
  default '{"daily_cap":100,"warmup_days":14,"warmup_start_cap":20}'::jsonb;

-- Accurate per-number 24h usage for a campaign's pool, grouped server-side so it
-- never hits PostgREST's 1,000-row response cap. Mirrors pre_call_check's cap
-- counting (AI outbound, not-failed).
create or replace function public.pool_number_usage_24h(in_campaign_id uuid)
returns table (twilio_number_id uuid, calls_24h bigint)
language sql
stable
security definer
set search_path = public
as $$
  select c.twilio_number_id, count(*)
    from public.calls c
   where c.campaign_id = in_campaign_id
     and c.direction = 'outbound'
     and c.call_mode = 'ai'
     and c.status <> 'failed'
     and c.twilio_number_id is not null
     and c.created_at >= now() - interval '24 hours'
   group by c.twilio_number_id;
$$;

comment on function public.pool_number_usage_24h is
  'Per-number outbound-AI call count over the trailing 24h for a campaign''s '
  'pool, grouped in SQL to dodge the 1,000-row cap. Used by selectPoolNumber '
  'to enforce per-number daily caps.';
