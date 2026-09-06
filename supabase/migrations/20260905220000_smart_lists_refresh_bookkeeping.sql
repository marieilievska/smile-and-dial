-- Smart lists: freshness bookkeeping + a cheaper "connected" probe.
--
-- Problem: the membership cache (smart_list_members) is rebuilt by a 3-minute
-- cron that nobody reads the response of. When refresh_smart_list() failed for
-- one list the loop threw, every list after it was skipped, and nothing anywhere
-- recorded that the cache had gone stale — the dialer kept calling yesterday's
-- members in silence. There was also no column to tell a user WHEN their list
-- was last rebuilt, so the picker could not say "Updated 2 min ago" or
-- "Refresh failed".
--
-- 1. smart_lists.last_refreshed_at / last_refresh_error: stamped by
--    refresh_smart_list() on success (below) and by the cron loop
--    (src/lib/smart-lists/cache.ts) on failure. The picker shows one line from
--    them.
-- 2. refresh_smart_list() body is the 20260804130000 owner-scoped version plus
--    the success stamp. CREATE OR REPLACE keeps the existing EXECUTE grants
--    (authenticated, for the inline attach refresh in campaigns/actions.ts;
--    service_role for the cron), so no re-grant is needed.
-- 3. calls (lead_id, outcome): the recipe's "connected" condition is a
--    correlated `exists (select 1 from calls c where c.lead_id = l.id and
--    c.outcome in (...))` per lead. calls_lead_id_idx only covers lead_id, so
--    every probe still had to fetch heap rows to test outcome. The composite
--    index answers the probe from the index alone.

alter table public.smart_lists
  add column if not exists last_refreshed_at timestamptz,
  add column if not exists last_refresh_error text;

comment on column public.smart_lists.last_refreshed_at is
  'When smart_list_members was last rebuilt successfully for this list. NULL '
  'until the first refresh (only lists attached to a campaign are refreshed).';
comment on column public.smart_lists.last_refresh_error is
  'Message from the most recent FAILED refresh; cleared on the next success. '
  'Non-null means the cached membership is stale.';

create or replace function public.refresh_smart_list(in_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_filter jsonb;
  v_owner uuid;
  v_count integer;
begin
  select filter, owner_id into v_filter, v_owner
  from public.smart_lists where id = in_id;
  if v_filter is null then
    delete from public.smart_list_members where smart_list_id = in_id;
    return 0;
  end if;

  delete from public.smart_list_members where smart_list_id = in_id;
  -- Only the list OWNER's (non-deleted) leads. Without the owner join this
  -- SECURITY DEFINER function would match every account's leads.
  insert into public.smart_list_members (smart_list_id, lead_id)
  select in_id, lf.lead_id
  from public.leads_matching_filter(v_filter) as lf(lead_id)
  join public.leads l on l.id = lf.lead_id
  where l.owner_id = v_owner
    and l.deleted_at is null
  on conflict do nothing;

  get diagnostics v_count = row_count;

  -- Success stamp. An exception anywhere above rolls this back too, so the
  -- column only ever moves forward on a rebuild that actually landed.
  update public.smart_lists
     set last_refreshed_at = now(),
         last_refresh_error = null
   where id = in_id;

  return v_count;
end;
$$;

create index if not exists calls_lead_id_outcome_idx
  on public.calls (lead_id, outcome);
