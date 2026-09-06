-- Close the five functions anon can still execute, and make "new functions
-- start closed" actually true.
--
-- ---------------------------------------------------------------------------
-- What went wrong
--
-- 20260905170000 locked every function in `public` away from PUBLIC / anon /
-- authenticated, and set the schema's default privileges so that future
-- functions would start closed too:
--
--     alter default privileges for role postgres in schema public
--       revoke execute on functions from public, anon, authenticated;
--
-- The first half worked. The second half does not. Measured, not guessed: a
-- throwaway function created as `postgres` inside a rolled-back transaction
-- came out with
--
--     =X/postgres | postgres=X/postgres | service_role=X/postgres
--
-- -- the leading `=X` being an EXECUTE grant to PUBLIC -- even though
-- pg_default_acl for (postgres, public, functions) reads `postgres=X |
-- service_role=X` with no PUBLIC in it. So every function created since that
-- migration has been executable by anon, which on this project means callable
-- over the internet through PostgREST with the publishable key that ships in
-- the browser bundle.
--
-- Read the ACL string with care, incidentally: ~39 functions carry `=X` in
-- proacl, but only six were actually anon-executable. The 20260905170000
-- revoke stripped anon from the rest by name. `has_function_privilege('anon',
-- oid, 'execute')` is the only answer worth trusting.
--
-- ---------------------------------------------------------------------------
-- The six, and why they are safe to close
--
--   evaluate_alerts()                    SECURITY DEFINER. Called only by the
--                                        alerts-evaluate cron job, as postgres.
--   alert_fire(text, uuid, interval)     SECURITY DEFINER. Called only from
--                                        inside evaluate_alerts (as owner) and
--                                        from src/lib/alerts/heartbeat.ts on
--                                        the dialer tick's SERVICE-ROLE client.
--                                        These two are the reason this matters:
--                                        an unauthenticated caller could drive
--                                        the alerting engine and write rows.
--   call_cost_total(jsonb)               Pure jsonb arithmetic, no table
--   call_cost_components(jsonb)          access. Harmless, but authenticated
--   cron_schedule_minutes(text)          now holds explicit grants for the two
--                                        the Analytics page reaches
--                                        (20260906041000), so nothing depends
--                                        on the PUBLIC grant.
--   list_performance(...)                Already closed in 20260906042000.
--
-- No application code calls any of them as anon or as a signed-in user, except
-- the two cost helpers, which keep their `authenticated` grant.
revoke execute on function public.evaluate_alerts() from public, anon;
revoke execute on function public.alert_fire(text, uuid, interval)
  from public, anon;
revoke execute on function public.call_cost_total(jsonb) from public, anon;
revoke execute on function public.call_cost_components(jsonb)
  from public, anon;
revoke execute on function public.cron_schedule_minutes(text)
  from public, anon;

-- ---------------------------------------------------------------------------
-- Stop it happening again
--
-- Since ALTER DEFAULT PRIVILEGES demonstrably does not close the PUBLIC grant
-- on this database, close it at creation time instead: an event trigger that
-- revokes PUBLIC and anon from every function created in `public`. Supabase's
-- own machinery uses ddl_command_end triggers here (pgrst_ddl_watch,
-- issue_pg_net_access), and `postgres` is permitted to create them -- also
-- verified in a rolled-back transaction before writing this.
--
-- Deliberate properties:
--   * It NEVER blocks DDL. Each revoke is wrapped so a failure raises a
--     warning and the migration carries on. A broken lock-down that lets a
--     function through is bad; one that makes every future migration fail is
--     worse.
--   * It only fires on CREATE FUNCTION, so an explicit `grant execute ... to
--     authenticated` later in the same migration still stands -- the trigger
--     has already run by then. That is the convention every function here
--     follows (cohort_rows, list_performance), and this makes forgetting it
--     fail closed rather than open.
--   * It is scoped to schema `public`. Extension schemas are none of its
--     business.
--   * SECURITY DEFINER so the revoke runs as the owner rather than as whoever
--     happened to run the DDL. An event trigger function cannot be called
--     directly, so this exposes nothing.
create or replace function public.lock_down_new_functions()
returns event_trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  obj record;
begin
  for obj in
    select object_identity
      from pg_event_trigger_ddl_commands()
     where schema_name = 'public'
       and object_type in ('function', 'procedure')
  loop
    begin
      execute format(
        'revoke execute on routine %s from public, anon', obj.object_identity
      );
    exception when others then
      -- Never abort the DDL that triggered us.
      raise warning 'lock_down_new_functions: could not close % (%)',
        obj.object_identity, sqlerrm;
    end;
  end loop;
end;
$$;

comment on function public.lock_down_new_functions() is
  'ddl_command_end event trigger: revokes EXECUTE from PUBLIC and anon on every '
  'function created in schema public, because ALTER DEFAULT PRIVILEGES does not '
  'close the PUBLIC grant on this database (20260906050000). Warns rather than '
  'raises, so it can never block a migration.';

-- Belt and braces: the trigger does not exist while its own function is being
-- created, so close that one by hand.
revoke execute on function public.lock_down_new_functions() from public, anon;

drop event trigger if exists lock_down_new_functions;
create event trigger lock_down_new_functions
  on ddl_command_end
  when tag in ('CREATE FUNCTION')
  execute function public.lock_down_new_functions();
