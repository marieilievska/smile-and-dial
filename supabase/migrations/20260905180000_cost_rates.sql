-- Effective provider rates, derived from the providers' own billing.
--
-- Every per-call price in the app was a constant in lib/costs/rates.ts:
-- ElevenLabs at $0.00016611/credit (the plan changed — the live account is
-- $990 / 6,269,494 credits = $0.00015791), and ALL Twilio voice at $0.0185/min
-- (the sub-account is actually billed $0.01203/min outbound, $0.0068/min
-- inbound, PLUS $0.0044/min of media-stream on every ElevenLabs-native call,
-- which nothing priced at all). Verified against the live APIs 2026-09-05.
--
-- This table holds the rate the daily refresh derives from each provider:
--   ElevenLabs  $/credit  = GET /v1/user/subscription
--                            next_invoice.amount_due_cents / 100 / character_limit
--   Twilio      $/minute  = GET /Usage/Records/ThisMonth.json?Category=...
--                            price / usage   (LastMonth when ThisMonth < 100 units)
--
-- Storage choice: one row PER RATE (keyed) rather than a jsonb column on
-- app_settings, so each rate carries its own `source` and `observed_at` and
-- the refresh can update one provider without rewriting the other's row.
-- lib/costs/rates.ts resolves: this table → env override → hard-coded default.
--
-- Readable by signed-in users (it is a price list, not customer data); written
-- only by the service role from the refresh route. No rows are seeded — until
-- the first refresh runs, pricing falls through to the verified defaults.

create table public.cost_rates (
  key text primary key check (
    key in (
      'elevenlabs_usd_per_credit',
      'twilio_outbound_usd_per_min',
      'twilio_inbound_usd_per_min',
      'twilio_media_stream_usd_per_min',
      'twilio_lookup_usd'
    )
  ),
  rate numeric not null check (rate >= 0),
  -- e.g. 'elevenlabs:subscription', 'twilio:usage:ThisMonth'
  source text not null,
  observed_at timestamptz not null default now(),
  -- The raw figures the rate was derived from (usage, price, plan …).
  detail jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

comment on table public.cost_rates is
  'Per-unit provider rates derived daily from ElevenLabs (plan price / '
  'credits) and Twilio usage records (price / usage). Read first by '
  'lib/costs/rates.ts; env and hard-coded defaults are the fallbacks.';

alter table public.cost_rates enable row level security;

create policy "cost_rates_select"
  on public.cost_rates
  for select
  to authenticated
  using (true);

-- No insert/update policies: the service role (refresh route) writes.

-- --- cron: refresh daily at 04:15 UTC via the maintenance route -------------
-- Same pg_net POST + x-dialer-secret pattern as retention-sweep. 04:15 UTC is
-- 00:15 ET, after the calling day and before the number-pool / best-time jobs.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid)
from cron.job
where jobname = 'cost-rates-refresh';

select cron.schedule(
  'cost-rates-refresh',
  '15 4 * * *',
  $cmd$
  select net.http_post(
    url := 'https://www.smile-and-dial.com/api/maintenance/cost-rates',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dialer-secret', coalesce(
        (select dialer_tick_secret from public.app_settings limit 1), ''
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cmd$
);
