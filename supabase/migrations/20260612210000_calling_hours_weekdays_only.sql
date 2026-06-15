-- Calling DAYS: the business calls Monday–Friday only.
--
-- is_within_calling_hours previously checked only the time-of-day window, so the
-- dialer (and the dial-queue view that uses this function) would happily place
-- calls on Saturday and Sunday. Combined with the scheduler — which counted
-- "N days ahead" with no weekday awareness — retries and "call back later"
-- (+1 day) landed on weekends, sat undialed, and went stale in the past.
--
-- Add a weekday gate (ISO day-of-week 1–5 = Mon–Fri) alongside the existing
-- time window, evaluated in the LEAD's local timezone. The scheduler now also
-- rolls weekend dates forward to Monday (see local-schedule.ts); this is the
-- authoritative dial-time backstop so a weekend timestamp can never dial.
create or replace function public.is_within_calling_hours(
  lead_timezone text,
  hours_start time,
  hours_end time
)
returns boolean
language sql
stable
as $$
  select
    extract(
      isodow from (now() at time zone coalesce(lead_timezone, 'America/New_York'))
    ) between 1 and 5
    and (
      now() at time zone coalesce(lead_timezone, 'America/New_York')
    )::time between hours_start and hours_end;
$$;

comment on function public.is_within_calling_hours is
  'True when the lead''s local time is a weekday (Mon–Fri) AND falls inside the '
  'campaign''s calling-hours window. Defaults to America/New_York if the lead '
  'has no timezone set.';
