-- Advanced-filter (Smart List recipe) -> matching lead ROWS, not just ids.
--
-- The id-returning leads_matching_filter forces callers to pass the full id set
-- back as .in("id", …), which overflowed the request URL (HTTP 414 "Request-URI
-- Too Large") once a filter matched more than a few hundred leads — so the Leads
-- page, the CSV/select-all export, and lead-detail prev/next all silently showed
-- nothing at scale. This sibling returns the rows themselves, so those callers
-- can filter/sort/paginate entirely DB-side: PostgREST treats a `setof leads`
-- function as a table source you can chain .select()/.eq()/.order()/.range() on.
--
-- Reuses the SAME predicate builder (_smart_list_node_sql), so the id and row
-- variants stay in lockstep. security invoker + stable so leads RLS still
-- applies (admin sees all, a member sees only their own).
create or replace function public.leads_matching_filter_rows(in_recipe jsonb)
returns setof public.leads
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
  sql := 'select l.* from public.leads l where l.deleted_at is null and '
    || coalesce(nullif(predicate, ''), 'true');
  return query execute sql;
end;
$$;

comment on function public.leads_matching_filter_rows is
  'Returns full lead rows matching a Smart List recipe (JSONB AND/OR tree), for '
  'DB-side filtering/sorting/pagination on the Leads page. Mirrors '
  'leads_matching_filter (ids) but avoids the giant .in("id",…) URL overflow.';
