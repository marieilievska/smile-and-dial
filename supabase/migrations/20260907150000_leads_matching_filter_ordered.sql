-- Give leads_matching_filter a deterministic row order, so paging it is safe.
--
-- src/lib/smart-lists/resolve.ts pages this function 1,000 ids at a time to get
-- past PostgREST's response cap. Postgres guarantees NOTHING about row order
-- across separate LIMIT/OFFSET queries, so without an `order by` two pages can
-- return the same id and never return another one -- silently, with no error.
-- Proven on production 2026-09-07 against the equivalent unordered pager on
-- `calls` (7,798 rows, 8 pages), four copies running at once:
--
--     run 1: fetched=7798 distinct=5431 duplicates=2367
--     run 2: fetched=7798 distinct=5872 duplicates=1926
--     run 3: fetched=7798 distinct=4852 duplicates=2946
--     run 4: fetched=7798 distinct=5545 duplicates=2253
--
-- a quarter to a third of the window counted twice and as much again never
-- seen. (`scripts/verify-pager-stability.mjs` reproduces it.)
--
-- This function did NOT drift when pushed the same way, and the reason is worth
-- writing down: it is plpgsql, so it is `parallel unsafe` by default and its
-- inner scan is never handed to parallel workers -- which is exactly what makes
-- the plain table pagers above non-deterministic. That protection is incidental.
-- Declaring this function `parallel safe` one day, a perfectly ordinary
-- optimisation, would remove it with nothing to warn you. The `order by` makes
-- the guarantee explicit instead of borrowed.
--
-- Ordering by `l.id` (the primary key) rather than any business column, because
-- the ONLY requirement is that the sequence is total and stable: a non-unique
-- column leaves ties free to reorder between pages, which is the same bug in a
-- smaller costume.
--
-- Body is otherwise the 20260619151000 original, unchanged. The sibling
-- leads_matching_filter_rows (20260810120000) needs no equivalent: its callers
-- chain .order()/.range() onto it from the client, which they can do because it
-- returns `setof public.leads` with real column names. This one returns
-- `setof uuid`, whose PostgREST column is not addressable
-- (`column leads_matching_filter.leads_matching_filter does not exist`), so the
-- order has to come from in here.
--
-- refresh_smart_list() also selects from this function, but as a SQL table
-- source in a single INSERT ... SELECT -- no LIMIT/OFFSET, so it was never
-- affected and its cached membership was never wrong. It just pays for one
-- extra sort, on a statement that already writes every matching row.
create or replace function public.leads_matching_filter(in_recipe jsonb)
returns setof uuid
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  predicate text;
  sql text;
begin
  predicate := public._smart_list_node_sql(in_recipe);
  sql := 'select l.id from public.leads l where l.deleted_at is null and '
    || coalesce(nullif(predicate, ''), 'true')
    -- Total, stable order: what makes .range() paging return each id once.
    || ' order by l.id';
  return query execute sql;
end;
$$;

comment on function public.leads_matching_filter is
  'Returns lead ids matching a Smart List recipe (JSONB AND/OR tree), ordered '
  'by lead id so callers can page it with .range() safely. Safe dynamic SQL: '
  'allow-listed fields/operators, format() quoting. RLS applies.';
