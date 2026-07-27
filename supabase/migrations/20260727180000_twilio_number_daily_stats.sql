-- Per-number connect-rate HISTORY.
--
-- The pool health monitor (monitor_twilio_connect_rates) keeps only a rolling
-- SNAPSHOT on twilio_numbers: last_calls_count_24h / last_connect_rate_24h are
-- overwritten on every run, so "is this number getting worse, or was yesterday a
-- blip?" was unanswerable. This table keeps one row per number per Eastern
-- calendar day so the trend is visible.
--
-- It matters more now that the per-number daily cap is off: the cap used to be
-- the thing stopping a number from over-dialing itself into a bad reputation, so
-- the trend line is the replacement early-warning signal.
--
-- Rows are RECOMPUTED from public.calls rather than incremented, so the refresh
-- is idempotent, survives missed cron runs, and self-heals if calls land late.

create table if not exists public.twilio_number_daily_stats (
  twilio_number_id uuid not null
    references public.twilio_numbers (id) on delete cascade,
  day date not null,
  calls integer not null default 0,
  connected integer not null default 0,
  connect_rate numeric,
  updated_at timestamptz not null default now(),
  primary key (twilio_number_id, day)
);

comment on table public.twilio_number_daily_stats is
  'One row per pool number per Eastern calendar day: outbound calls placed, how '
  'many connected, and the resulting rate. Recomputed from public.calls by '
  'refresh_twilio_number_daily_stats(). The source of truth for connect-rate '
  'TREND, as opposed to the rolling 24h snapshot columns on twilio_numbers.';

create index if not exists twilio_number_daily_stats_day_idx
  on public.twilio_number_daily_stats (day desc);

alter table public.twilio_number_daily_stats enable row level security;

-- Read-only to admins (the Twilio numbers page is admin-gated). Writes happen
-- through the security-definer refresh function called by pg_cron.
drop policy if exists "twilio_number_daily_stats_select"
  on public.twilio_number_daily_stats;
create policy "twilio_number_daily_stats_select"
  on public.twilio_number_daily_stats
  for select
  to authenticated
  using (public.is_admin((select auth.uid())));

-- ---------------------------------------------------------------------------
-- Refresh
-- ---------------------------------------------------------------------------
-- "Connected" uses the SAME definition as monitor_twilio_connect_rates (a human
-- or gatekeeper picked up) so the history agrees with the live 24h figure the
-- numbers page shows. Keep the two in sync if either changes.
create or replace function public.refresh_twilio_number_daily_stats(
  in_days_back integer default 3
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
  v_from date;
begin
  v_from := (now() at time zone 'America/New_York')::date
              - greatest(0, coalesce(in_days_back, 3));

  insert into public.twilio_number_daily_stats
    (twilio_number_id, day, calls, connected, connect_rate, updated_at)
  select
    c.twilio_number_id,
    (c.created_at at time zone 'America/New_York')::date,
    count(*),
    count(*) filter (
      where c.outcome is not null
        and c.outcome not in
            ('voicemail', 'no_answer', 'busy', 'failed', 'invalid_number')
    ),
    round(
      count(*) filter (
        where c.outcome is not null
          and c.outcome not in
              ('voicemail', 'no_answer', 'busy', 'failed', 'invalid_number')
      )::numeric / nullif(count(*), 0),
      4
    ),
    now()
    from public.calls c
   where c.twilio_number_id is not null
     and c.direction = 'outbound'
     and (c.created_at at time zone 'America/New_York')::date >= v_from
   group by 1, 2
  on conflict (twilio_number_id, day) do update
     set calls = excluded.calls,
         connected = excluded.connected,
         connect_rate = excluded.connect_rate,
         updated_at = now();

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

comment on function public.refresh_twilio_number_daily_stats is
  'Recompute per-number, per-Eastern-day outbound call + connect counts for the '
  'trailing in_days_back days and upsert them into twilio_number_daily_stats. '
  'Idempotent: safe to re-run, and re-running repairs days whose calls settled '
  'after the last pass.';

-- Backfill whatever history the calls table still holds, so the trend does not
-- start empty on deploy.
select public.refresh_twilio_number_daily_stats(400);

-- Same 30-minute cadence as the health monitor, so a number's trend line and its
-- rest/flag decisions are never more than half an hour apart. cron.schedule
-- upserts by jobname, so re-applying this migration is safe.
create extension if not exists pg_cron;

select cron.schedule(
  'twilio-number-daily-stats',
  '*/30 * * * *',
  $$ select public.refresh_twilio_number_daily_stats(3); $$
);
