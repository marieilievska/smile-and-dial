-- Let a signed-in user compute a call's cost.
--
-- Caught by simulating each role against list_performance (20260906040000),
-- which is the first SECURITY INVOKER caller of call_cost_total: as
-- `authenticated` it failed outright with
--
--     permission denied for function j_num
--
-- call_cost_total is a plain (not SECURITY DEFINER) SQL function, so its
-- internals run with the CALLER's privileges. It delegates to
-- call_cost_components and j_num, and while the first two carry an execute
-- grant, j_num -- created after the function lock-down (20260905170000), which
-- made new functions start closed -- carried none. Nothing noticed because
-- every existing caller is the cost roll-up, the spend-cap monitor or a
-- backfill, all of which run as postgres or service_role.
--
-- Granting these three is safe by inspection: all IMMUTABLE, all
-- `set search_path to ''`, none touches a table. They turn jsonb the caller
-- already holds into a number, so there is nothing to leak. The alternative --
-- duplicating the cost arithmetic inside list_performance -- would give the
-- app a second definition of what a call costs, which is exactly the drift
-- that left 1,183 rows with a stale total.
--
-- The two that already have it are granted explicitly anyway, so the
-- dependency is written down and survives the next lock-down sweep.
grant execute on function public.j_num(jsonb, text) to authenticated;
grant execute on function public.call_cost_components(jsonb) to authenticated;
grant execute on function public.call_cost_total(jsonb) to authenticated;
