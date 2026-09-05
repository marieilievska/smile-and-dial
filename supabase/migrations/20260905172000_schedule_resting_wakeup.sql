-- Wake resting leads: fix expire_resting_leads() and actually schedule it.
--
-- The retry engine parks a lead as `resting` with a `resting_until` (30 d for
-- not-interested, 15 d for the shorter cases; a manual "Resting" pick stamps
-- 15 d). `expire_resting_leads()` (20260525210000) was written to flip those
-- leads back to `ready_to_call` once the date passes — but its cron
-- (20260525220000) was left commented out "until the dialer is running" and
-- never turned on. So every rested lead stayed `resting` forever: 401 of them
-- today, the first due 2026-09-17, and none would ever have been redialed.
--
-- Two changes:
--
--   1. The function set `next_call_at = now()` on wake-up. Whenever the cron
--      fires (day or night), that would have made the lead due immediately.
--      Calling hours are enforced by dial_queue / pre_call_check per campaign,
--      so it wouldn't have dialed at 3 AM — but it would have jumped every
--      woken lead to the front of the queue at once, ahead of leads that were
--      scheduled for a specific time. Now `next_call_at = resting_until`: the
--      lead becomes due at the exact moment its rest ended (which is also what
--      the retry engine and the manual Resting action already write into
--      next_call_at when they park it), and the dialer's normal ordering and
--      calling-hours gates decide when it is actually dialed.
--      Also skips soft-deleted leads (`deleted_at is null`), which the original
--      did not.
--
--   2. Schedule it every 30 minutes as `expire-resting-leads`. Idempotent —
--      unschedules any prior job of that name (and the never-used dormant
--      name) first. The job runs as postgres inside pg_cron, so no execute
--      grant is added here; a separate change is tightening function grants
--      app-wide and the existing grant is left for it to handle.

create extension if not exists pg_cron;

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
         -- Due at the moment the rest ended, NOT now(): keeps the lead in its
         -- rightful place in the queue and lets the dialer's calling-hours
         -- gate decide when it is actually dialed.
         next_call_at = resting_until,
         resting_until = null,
         updated_at = now()
   where status = 'resting'
     and resting_until is not null
     and resting_until <= now()
     and deleted_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.expire_resting_leads is
  'Runs every 30 min via pg_cron (expire-resting-leads). Flips leads out of '
  '`resting` back to `ready_to_call` once resting_until has passed, with '
  'next_call_at = resting_until so the dialer''s ordering and calling-hours '
  'gates still apply. Skips soft-deleted leads. Returns the number of leads '
  'updated.';

-- Idempotent (re)schedule: drop any existing job with either name first.
select cron.unschedule(jobid)
from cron.job
where jobname in ('expire-resting-leads', 'expire-resting-leads-nightly');

select cron.schedule(
  'expire-resting-leads',
  '*/30 * * * *',
  $$ select public.expire_resting_leads(); $$
);
