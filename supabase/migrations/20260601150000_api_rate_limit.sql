-- ---------------------------------------------------------------------------
-- Public API rate limiting (audit follow-up #6).
--
-- POST /api/v1/leads runs under the service-role key and had no throttle:
-- a single valid key could loop unbounded lead/list inserts, exhausting the
-- DB and amplifying downstream calling cost.
--
-- Fixed-window counter, keyed by (api_key_id, window_start). Each request
-- atomically increments the current window's count via INSERT ... ON
-- CONFLICT DO UPDATE and gets back the new count; the route rejects with
-- 429 once it exceeds the limit. Fixed-window is simple, race-free under
-- concurrency (the upsert is atomic), and good enough for abuse protection.
-- ---------------------------------------------------------------------------
create table if not exists public.api_rate_limits (
  api_key_id uuid not null references public.api_keys (id) on delete cascade,
  window_start timestamptz not null,
  request_count integer not null default 0,
  primary key (api_key_id, window_start)
);

create index if not exists api_rate_limits_window_idx
  on public.api_rate_limits (window_start);

-- No RLS — server-side counter written by the public API route under the
-- service role, never read by end users.
alter table public.api_rate_limits disable row level security;

-- Atomically record one request in the current fixed window and return the
-- running count for that window. The window is the UTC minute floored to
-- `in_window_seconds`. Caller compares the returned count to its limit.
create or replace function public.bump_api_rate_limit(
  in_api_key_id uuid,
  in_window_seconds integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_start timestamptz;
  v_count integer;
begin
  -- Floor now() to the start of the current window.
  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / in_window_seconds) * in_window_seconds
  );

  insert into public.api_rate_limits (api_key_id, window_start, request_count)
  values (in_api_key_id, v_window_start, 1)
  on conflict (api_key_id, window_start)
  do update set request_count = public.api_rate_limits.request_count + 1
  returning request_count into v_count;

  return v_count;
end;
$$;

comment on function public.bump_api_rate_limit is
  'Atomically increment and return the request count for an API key in the '
  'current fixed window. The public API route rejects with 429 when the '
  'returned count exceeds its per-window limit.';

grant execute on function public.bump_api_rate_limit(uuid, integer)
  to authenticated, anon, service_role;
