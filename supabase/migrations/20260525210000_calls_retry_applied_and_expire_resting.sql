-- Step 24 — retry engine support.
--
-- 1. `calls.retry_applied_at` — idempotency marker for the retry engine.
--    The Twilio status webhook and the ElevenLabs post-call webhook can
--    both observe a terminal outcome for the same call. Whichever runs
--    first wins the right to apply retry rules; the second one no-ops.
--
-- 2. `expire_resting_leads()` — the nightly job (Section 8 line 677) that
--    flips a lead out of `resting` back to `ready_to_call` once its
--    resting_until passes. Kept as a callable function; the pg_cron
--    schedule that fires it is documented in a separate dormant migration.

alter table public.calls
  add column retry_applied_at timestamptz;

comment on column public.calls.retry_applied_at is
  'Set once by whichever webhook successfully runs the retry engine for '
  'this call. Used as an idempotency lock so a second webhook can''t '
  'double-bump the lead''s retry counter.';

create or replace function public.expire_resting_leads()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.leads
     set status = 'ready_to_call',
         next_call_at = now(),
         resting_until = null,
         updated_at = now()
   where status = 'resting'
     and resting_until is not null
     and resting_until <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.expire_resting_leads is
  'Nightly job — flips leads out of `resting` back to `ready_to_call` when '
  'their resting_until has passed. Returns the number of leads updated.';

grant execute on function public.expire_resting_leads() to authenticated;
