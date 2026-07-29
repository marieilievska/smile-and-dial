-- Record, per outbound call, how local the caller ID was to the lead and which
-- country we dialled. Both are stamped at placement by the dialer from the tier
-- pickPoolNumber already chose, so they record what actually happened rather
-- than re-deriving it later from a lead's phone (which can change).
--
-- Nullable and additive: existing rows stay null, nothing reads them yet.
-- The Reporting "Numbers" tab and the number-health monitor rewrite are the
-- consumers.

alter table public.calls
  add column if not exists local_match  text,
  add column if not exists dest_country text;

alter table public.calls
  drop constraint if exists calls_local_match_check;
alter table public.calls
  add constraint calls_local_match_check
  check (local_match is null or local_match in ('exact', 'state', 'none'));

alter table public.calls
  drop constraint if exists calls_dest_country_check;
alter table public.calls
  add constraint calls_dest_country_check
  check (dest_country is null or dest_country in ('US', 'CA'));

comment on column public.calls.local_match is
  'Local-presence tier the caller ID had for this lead at placement: exact '
  '(same area code), state (same US state), none. Null for inbound, human '
  'browser dials, and every call placed before 2026-07-29.';
comment on column public.calls.dest_country is
  'Destination country derived from the lead area code at placement: US or CA. '
  'Null when the number is non-geographic (toll-free) or pre-dates this column.';

-- Reporting reads these grouped by number and by day.
create index if not exists calls_local_match_idx
  on public.calls (local_match) where local_match is not null;
create index if not exists calls_dest_country_idx
  on public.calls (dest_country) where dest_country is not null;
