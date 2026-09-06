-- Campaigns was downloading the whole leads table to learn seven values.
--
-- ---------------------------------------------------------------------------
-- What it was doing
--
-- /campaigns shows a "are we calling right now?" chip per campaign, evaluated
-- in the LEADS' timezones rather than the server's UTC clock (the dialer gates
-- per lead the same way). To get those timezones, src/app/(app)/campaigns/
-- page.tsx paged `leads` through fetchAllRows -- 1,000 rows a request, in a
-- sequential loop -- and built a Set in JavaScript.
--
-- Measured on production, 2026-09-06:
--
--     rows pulled    83,980   (leads, not deleted, timezone not null)
--     round trips    ~84      sequential, each waiting on the last
--     rows needed    7        distinct (list_id, timezone) pairs
--     page render    7,031ms / 7,540ms / 6,177ms across three runs
--
-- ~12,000x more data than the answer needs, to render ONE campaign. All seven
-- pairs were already in the first page. The authenticated statement timeout on
-- this project is 8s, so the page was rendering about half a second short of
-- failing outright -- and the cost grows linearly with the lead count, so the
-- 150k-lead target would have taken it past the line.
--
-- ---------------------------------------------------------------------------
-- What replaces it
--
-- The DISTINCT the JavaScript was emulating, run where the rows already live.
-- One round trip, seven rows.
--
-- SECURITY INVOKER, deliberately: the old code read `leads` through the
-- signed-in user's client, so RLS already scoped a member to their own leads'
-- timezones. Keeping INVOKER preserves that exactly -- a member still sees only
-- the timezones of leads they can see, and a super admin still sees all of
-- them. A DEFINER function here would have quietly widened what a member's
-- "calling now?" chip is computed from.
--
-- The `set search_path` clause blocks inlining, which is the right trade here
-- and the opposite of the call_cost_total case (20260906055000): that one is a
-- scalar called once per row, where losing inlining cost 3.2s over 8k rows.
-- This one is called once per page load.
create or replace function public.list_lead_timezones(p_list_ids uuid[])
returns table (list_id uuid, timezone text)
language sql
stable
security invoker
set search_path = public
as $$
  select distinct l.list_id, l.timezone
    from leads l
   where l.list_id = any(p_list_ids)
     and l.deleted_at is null
     and l.timezone is not null;
$$;

comment on function public.list_lead_timezones(uuid[]) is
  'Distinct (list_id, timezone) pairs for the given lists, for the Campaigns '
  '"calling now?" chip. Replaces a full paged scan of `leads` that pulled ~84k '
  'rows to compute ~7 (20260906070000). SECURITY INVOKER so RLS scopes a member '
  'to their own leads, exactly as the paged read did.';

-- The event trigger from 20260906050000 has already closed this to PUBLIC and
-- anon by the time this line runs; the page calls it as a signed-in user.
grant execute on function public.list_lead_timezones(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Make it an index-only scan
--
-- `leads_list_id_idx` (list_id) alone means an index scan followed by ~84k heap
-- fetches just to read `timezone` and `deleted_at`. Carrying timezone in the
-- index and excluding soft-deleted rows lets Postgres answer the DISTINCT from
-- the index alone.
--
-- Partial on `deleted_at is null` so it stays proportional to the LIVE table
-- rather than to everything ever imported, and so it matches the function's
-- predicate exactly. Not CONCURRENTLY: supabase migrations run inside a
-- transaction, which forbids it, and at this table size the plain build is
-- sub-second.
create index if not exists leads_list_timezone_idx
  on public.leads (list_id, timezone)
  where deleted_at is null and timezone is not null;

comment on index public.leads_list_timezone_idx is
  'Covering index for list_lead_timezones(): lets the Campaigns timezone '
  'DISTINCT run index-only instead of touching the heap (20260906070000).';
