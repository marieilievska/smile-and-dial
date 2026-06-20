-- Translate a Smart List "recipe" (JSONB AND/OR tree) into a lead-id set.
-- Safe dynamic SQL: allow-listed fields + operators, format() %I/%L quoting.
-- security invoker + stable, so leads RLS applies (admin sees all).

-- Text/enum operators against an already-safe column expression.
create or replace function public._smart_list_text_sql(col text, op text, val jsonb)
returns text
language plpgsql
immutable
as $$
declare arr text[];
begin
  case op
    when 'is' then
      return format('%s = %L', col, val#>>'{}');
    when 'is_not' then
      return format('%s is distinct from %L', col, val#>>'{}');
    when 'contains' then
      return format('%s ilike %L', col, '%' || coalesce(val#>>'{}','') || '%');
    when 'not_contains' then
      return format('(%s is null or %s not ilike %L)', col, col,
        '%' || coalesce(val#>>'{}','') || '%');
    when 'is_empty' then
      return format('(%s is null or %s = '''')', col, col);
    when 'has_value' then
      return format('(%s is not null and %s <> '''')', col, col);
    when 'is_any_of' then
      if jsonb_typeof(val) <> 'array' then return 'false'; end if;
      select array_agg(quote_literal(x)) into arr
        from jsonb_array_elements_text(val) as x;
      if arr is null then return 'false'; end if;
      return format('%s in (%s)', col, array_to_string(arr, ','));
    when 'is_none_of' then
      if jsonb_typeof(val) <> 'array' then return 'true'; end if;
      select array_agg(quote_literal(x)) into arr
        from jsonb_array_elements_text(val) as x;
      if arr is null then return 'true'; end if;
      return format('(%s is null or %s not in (%s))', col, col,
        array_to_string(arr, ','));
    else
      return 'false';
  end case;
end;
$$;

-- Numeric operators.
create or replace function public._smart_list_num_sql(col text, op text, val jsonb)
returns text
language plpgsql
immutable
as $$
declare a numeric; b numeric;
begin
  case op
    when 'is_empty' then return format('%s is null', col);
    when 'between' then
      if jsonb_typeof(val) <> 'array' or jsonb_array_length(val) < 2 then
        return 'false';
      end if;
      a := nullif(val->>0,'')::numeric; b := nullif(val->>1,'')::numeric;
      if a is null or b is null then return 'false'; end if;
      return format('%s between %L and %L', col, a, b);
    else
      a := nullif(val#>>'{}','')::numeric;
      if a is null then return 'false'; end if;
      return format('%s %s %L', col,
        case op when 'eq' then '=' when 'neq' then '<>'
                when 'gt' then '>' when 'lt' then '<' else '=' end, a);
  end case;
end;
$$;

-- Date operators (col is timestamptz; values are YYYY-MM-DD).
create or replace function public._smart_list_date_sql(col text, op text, val jsonb)
returns text
language plpgsql
immutable
as $$
declare d text; d2 text; n int;
begin
  case op
    when 'is_empty' then return format('%s is null', col);
    when 'in_last_days' then
      n := nullif(val#>>'{}','')::int;
      if n is null then return 'false'; end if;
      return format('%s >= now() - (%L || '' days'')::interval', col, n);
    when 'before' then
      d := val#>>'{}'; if d is null or d = '' then return 'false'; end if;
      return format('%s < %L::date', col, d);
    when 'after' then
      d := val#>>'{}'; if d is null or d = '' then return 'false'; end if;
      return format('%s >= (%L::date + 1)', col, d);
    when 'between' then
      if jsonb_typeof(val) <> 'array' or jsonb_array_length(val) < 2 then
        return 'false';
      end if;
      d := val->>0; d2 := val->>1;
      if d is null or d = '' or d2 is null or d2 = '' then return 'false'; end if;
      return format('%s >= %L::date and %s < (%L::date + 1)', col, d, col, d2);
    else
      return 'false';
  end case;
end;
$$;

-- Custom field condition: EXISTS over lead_custom_values joined to defs by slug.
create or replace function public._smart_list_custom_sql(slug text, op text, val jsonb)
returns text
language plpgsql
immutable
as $$
declare inner_cond text; arr text[];
begin
  if op = 'is_empty' then
    return format('not exists (select 1 from public.lead_custom_values v '
      || 'join public.custom_field_defs d on d.id = v.custom_field_id '
      || 'where v.lead_id = l.id and d.slug = %L and v.value is not null '
      || 'and (v.value #>> ''{}'') <> '''')', slug);
  elsif op = 'has_value' then
    return format('exists (select 1 from public.lead_custom_values v '
      || 'join public.custom_field_defs d on d.id = v.custom_field_id '
      || 'where v.lead_id = l.id and d.slug = %L and v.value is not null '
      || 'and (v.value #>> ''{}'') <> '''')', slug);
  elsif op = 'is_none_of' then
    if jsonb_typeof(val) <> 'array' then return 'true'; end if;
    select array_agg(quote_literal(x)) into arr
      from jsonb_array_elements_text(val) as x;
    if arr is null then return 'true'; end if;
    return format('not exists (select 1 from public.lead_custom_values v '
      || 'join public.custom_field_defs d on d.id = v.custom_field_id '
      || 'where v.lead_id = l.id and d.slug = %L '
      || 'and (v.value #>> ''{}'') in (%s))', slug, array_to_string(arr, ','));
  end if;

  case op
    when 'is' then
      inner_cond := format('(v.value #>> ''{}'') = %L', val#>>'{}');
    when 'contains' then
      inner_cond := format('(v.value #>> ''{}'') ilike %L',
        '%' || coalesce(val#>>'{}','') || '%');
    when 'not_contains' then
      inner_cond := format('(v.value #>> ''{}'') not ilike %L',
        '%' || coalesce(val#>>'{}','') || '%');
    when 'is_any_of' then
      if jsonb_typeof(val) <> 'array' then return 'false'; end if;
      select array_agg(quote_literal(x)) into arr
        from jsonb_array_elements_text(val) as x;
      if arr is null then return 'false'; end if;
      inner_cond := format('(v.value #>> ''{}'') in (%s)',
        array_to_string(arr, ','));
    else
      return 'false';
  end case;

  return format('exists (select 1 from public.lead_custom_values v '
    || 'join public.custom_field_defs d on d.id = v.custom_field_id '
    || 'where v.lead_id = l.id and d.slug = %L and %s)', slug, inner_cond);
end;
$$;

-- Build the SQL predicate for ONE recipe node (group or condition).
create or replace function public._smart_list_node_sql(node jsonb)
returns text
language plpgsql
immutable
as $$
declare
  comb text;
  child jsonb;
  parts text[] := '{}';
  fld text;
  op text;
  val jsonb;
  slug text;
  -- The canonical CONNECTED_OUTCOMES set (mirror of src/lib/calls/outcomes.ts).
  connected_in constant text :=
    '(''goal_met'',''callback'',''call_back_later'',''not_interested'','
    || '''gatekeeper'',''transferred_to_human'',''language_barrier'','
    || '''hung_up_immediately'',''ai_error'',''dnc'')';
begin
  if node is null or jsonb_typeof(node) <> 'object' then
    return 'true';
  end if;

  -- Group node.
  if node ? 'combinator' then
    comb := case when node->>'combinator' = 'or' then ' or ' else ' and ' end;
    if jsonb_typeof(node->'children') <> 'array'
       or jsonb_array_length(node->'children') = 0 then
      return 'true';
    end if;
    for child in select jsonb_array_elements(node->'children') loop
      parts := parts || public._smart_list_node_sql(child);
    end loop;
    return '(' || array_to_string(parts, comb) || ')';
  end if;

  -- Condition leaf.
  fld := node->>'field';
  op  := node->>'operator';
  val := node->'value';

  if fld like 'custom:%' then
    slug := substr(fld, 8);
    if slug !~ '^[a-z0-9_]+$' then return 'false'; end if;
    return public._smart_list_custom_sql(slug, op, val);
  end if;

  case fld
    when 'status' then
      return public._smart_list_text_sql('l.status', op, val);
    when 'city' then
      return public._smart_list_text_sql('l.city', op, val);
    when 'state' then
      return public._smart_list_text_sql('l.state', op, val);
    when 'timezone' then
      return public._smart_list_text_sql('l.timezone', op, val);
    when 'owner_id' then
      return public._smart_list_text_sql('l.owner_id::text', op, val);
    when 'attempts' then
      return public._smart_list_num_sql('l.call_attempts', op, val);
    when 'created_at' then
      return public._smart_list_date_sql('l.created_at', op, val);
    when 'last_called' then
      return public._smart_list_date_sql('l.last_call_at', op, val);
    when 'dm_reached' then
      return case when op = 'is_true'
        then 'l.decision_maker_reached is true'
        else 'coalesce(l.decision_maker_reached, false) is false' end;
    when 'goal_met' then
      return case when op = 'is_true'
        then '(l.status = ''goal_met'')'
        else '(l.status is distinct from ''goal_met'')' end;
    when 'connected' then
      if op = 'is_true' then
        return 'exists (select 1 from public.calls c where c.lead_id = l.id '
          || 'and c.outcome in ' || connected_in || ')';
      else
        return 'not exists (select 1 from public.calls c where c.lead_id = l.id '
          || 'and c.outcome in ' || connected_in || ')';
      end if;
    else
      return 'false';
  end case;
end;
$$;

-- Public entry point: recipe -> matching lead ids.
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
    || coalesce(nullif(predicate, ''), 'true');
  return query execute sql;
end;
$$;

comment on function public.leads_matching_filter is
  'Returns lead ids matching a Smart List recipe (JSONB AND/OR tree). Safe '
  'dynamic SQL: allow-listed fields/operators, format() quoting. RLS applies.';
