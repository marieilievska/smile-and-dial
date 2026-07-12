-- Enable Supabase Realtime for the calls table.
--
-- The live pages (Today, Leads, Lead detail, Calls) subscribe to
-- postgres_changes on public.calls via <AutoRefresh realtime> so the "on
-- call" pulse and call outcomes update by PUSH the instant a row moves,
-- instead of every client polling on a timer. This is what lets us drop the
-- old 8s app-wide poll down to a slow 60s safety-net fallback.
--
-- Realtime honours RLS. calls already has an authenticated SELECT policy
-- scoped to the caller (a member sees calls for leads they own; admins see
-- all), so each browser only receives change events for calls it can already
-- read. No new exposure.
--
-- INSERT/UPDATE carry the new row under the default (primary-key) replica
-- identity, which is all we need — calls are never deleted, so we don't need
-- REPLICA IDENTITY FULL for old-row payloads.
--
-- Idempotent: only add the table if it isn't already a member of the
-- supabase_realtime publication (which Supabase creates by default).
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'calls'
  ) then
    alter publication supabase_realtime add table public.calls;
  end if;
end $$;
