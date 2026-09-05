-- Alerting for silent stops, part 1: the heartbeat + the dedupe primitive.
--
-- Verified live 2026-09-05: when outbound dialing stops, nothing tells anyone.
-- The campaign stays `active`, the dialer tick returns a summary that nobody
-- stores, and pg_net's response rows are auto-pruned unread. Every known
-- silent stop (daily/hourly cap, every pool number rested, a dial_queue read
-- error, tick 401s/timeouts, a credit-read outage, a cron job that quietly
-- stopped, a failing post-call webhook) looked identical from the app: a
-- green "Active" badge and no calls.
--
-- This migration adds the two tables the alerting needs:
--
--   1. `dialer_heartbeats` — one row per dialer tick, written by the app at
--      the end of every run (src/lib/dialer/tick.ts). Holds the counts the
--      tick already computes plus the two new stop signals it used to
--      discard: `queue_read_failed` (a dial_queue / campaign read errored and
--      was previously counted as "0 candidates") and
--      `pool_exhausted_campaigns` (which campaigns had no usable number).
--      The SQL evaluator (next migration) reads the newest rows to tell
--      "the tick isn't running" from "the tick runs but nothing dials".
--      The app prunes rows older than 7 days on the same insert path.
--
--   2. `alert_state` — (rule, ref_id) -> last_fired_at. Every alert rule
--      fires at most once per ref per period; `alert_fire()` is the single
--      atomic claim used by both the SQL evaluator and the app (via rpc), so
--      a rule can never double-notify across the two.
--
-- Both tables are service-role only: RLS on, no policies. The evaluator is
-- SECURITY DEFINER and runs as postgres under pg_cron; the tick uses the
-- service role. Nothing user-facing reads them directly — alerts surface as
-- ordinary `notifications` rows.
--
-- REMINDER: after 20260905170000 a new function is executable by postgres
-- and service_role only. alert_fire() is called by the tick (service_role)
-- and by evaluate_alerts() (postgres) — no authenticated grant, on purpose.

create table if not exists public.dialer_heartbeats (
  id uuid primary key default gen_random_uuid(),
  ran_at timestamptz not null default now(),
  duration_ms integer,
  candidates integer not null default 0,
  dialed integer not null default 0,
  errors integer not null default 0,
  blocked_reasons jsonb not null default '{}'::jsonb,
  pool_exhausted_campaigns uuid[] not null default '{}'::uuid[],
  queue_read_failed boolean not null default false,
  summary jsonb
);

comment on table public.dialer_heartbeats is
  'One row per dialer tick, written by runDialerTick at the end of every run '
  '(including the early-return paths). Read by evaluate_alerts() to detect a '
  'stalled dialer. The app prunes rows older than 7 days. Service-role only.';

create index if not exists dialer_heartbeats_ran_at_idx
  on public.dialer_heartbeats (ran_at desc);

alter table public.dialer_heartbeats enable row level security;
-- No policies: only the service role and the SECURITY DEFINER evaluator touch it.

create table if not exists public.alert_state (
  rule text not null,
  ref_id uuid not null,
  last_fired_at timestamptz not null default now(),
  primary key (rule, ref_id)
);

comment on table public.alert_state is
  'Alert dedupe: (rule, ref_id) -> when that rule last fired for that ref. '
  'Claimed atomically through alert_fire(). Global rules use the nil uuid as '
  'ref_id; cron jobs use md5(jobname)::uuid. Service-role only.';

alter table public.alert_state enable row level security;
-- No policies: see above.

-- Atomic once-per-period claim. Returns true exactly once per (rule, ref)
-- per period: the first caller inside a period wins and stamps
-- last_fired_at; every later caller inside the same period gets false. Safe
-- to call from concurrent ticks / the evaluator — the INSERT ... ON CONFLICT
-- serialises on the primary key.
create or replace function public.alert_fire(
  in_rule text,
  in_ref uuid,
  in_period interval
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer := 0;
begin
  insert into public.alert_state as s (rule, ref_id, last_fired_at)
  values (in_rule, in_ref, now())
  on conflict (rule, ref_id) do update
    set last_fired_at = excluded.last_fired_at
    where s.last_fired_at <= now() - in_period;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

comment on function public.alert_fire(text, uuid, interval) is
  'Once-per-period claim for an alert rule. True when this call is the first '
  'for (rule, ref) inside the period (and stamps last_fired_at); false '
  'otherwise. Used by evaluate_alerts() and by the dialer tick via rpc.';

-- Indexes the evaluator leans on. calls already has single-column indexes
-- on campaign_id and created_at; the cap and stall rules filter on BOTH
-- (one campaign, a recent window), which a composite serves as a short
-- range scan instead of a bitmap-and over the whole campaign's history.
create index if not exists calls_campaign_id_created_at_idx
  on public.calls (campaign_id, created_at desc);

-- system_events had no index at all. The placement-storm rule counts one
-- kind over a 10-minute window every 5 minutes; this keeps that a range scan
-- (and helps the Activity feed's per-kind reads for free).
create index if not exists system_events_kind_created_at_idx
  on public.system_events (kind, created_at desc);
