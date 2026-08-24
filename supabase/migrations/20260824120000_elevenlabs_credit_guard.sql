-- ElevenLabs credit guard.
--
-- 1. `elevenlabs_credit_status` — single-row cache of the shared workspace
--    credit balance, written by the dialer tick's credit guard. Holds the
--    previous state (for one-shot transition detection across serverless
--    invocations) and a throttle timestamp for read-failure logging.
--    Service-role only (RLS on, no policies) — background job writes/reads it.
--
-- 2. `campaigns.paused_reason` — allow 'low_credits' so the guard can auto-pause
--    and, on recovery, auto-resume ONLY the campaigns it paused.

create table public.elevenlabs_credit_status (
  id int primary key default 1 check (id = 1),
  remaining bigint,
  credit_limit bigint,
  state text check (state in ('ok', 'warn', 'low')),
  checked_at timestamptz,
  read_error_logged_at timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.elevenlabs_credit_status is
  'Single-row cache of the shared ElevenLabs credit balance, written by the '
  'dialer tick credit guard. Service-role only.';

insert into public.elevenlabs_credit_status (id) values (1)
  on conflict (id) do nothing;

alter table public.elevenlabs_credit_status enable row level security;
-- No policies: only the service role (background jobs) reads/writes this row.

-- Widen the paused_reason CHECK to include the guard's reason. Drop the existing
-- check by introspection (its auto-generated name is normally
-- campaigns_paused_reason_check, but we don't rely on that) so we can't end up
-- with a stale constraint that still rejects 'low_credits'.
do $$
declare
  c text;
begin
  select conname into c
    from pg_constraint
   where conrelid = 'public.campaigns'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%paused_reason%';
  if c is not null then
    execute format('alter table public.campaigns drop constraint %I', c);
  end if;
end $$;

alter table public.campaigns
  add constraint campaigns_paused_reason_check check (
    paused_reason is null
    or paused_reason in (
      'manual', 'daily_spend_cap', 'monthly_spend_cap', 'auto', 'low_credits'
    )
  );
