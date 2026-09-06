-- Smart-list "connected" condition: use the app-wide CONNECTED_OUTCOMES list.
--
-- _smart_list_node_sql() carried its own copy of the connected-outcome list
-- from 2026-06-19. It drifted from src/lib/calls/outcomes.ts in both
-- directions: it was missing `gatekeeper_not_interested` and `hung_up_later`
-- (a person picked up in both), and it still counted `ai_error` (OUR platform
-- failure, deliberately excluded everywhere else since 2026-08-11). So a smart
-- list filtered on "connected = true" disagreed with every connect-rate
-- surface in the app about which leads had been reached.
--
-- The body below is the 20260619151000 definition with only the list changed
-- to the canonical 11 values. tests/smart-list-connected-outcomes.unit.test.ts
-- parses this constant and asserts it equals CONNECTED_OUTCOMES, so the two
-- cannot drift again without a failing test. CREATE OR REPLACE keeps the
-- existing EXECUTE grant to authenticated (20260905170000), which the
-- SECURITY INVOKER filter functions need.

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
  -- KEEP IN STEP: tests/smart-list-connected-outcomes.unit.test.ts reads it.
  connected_in constant text :=
    '(''goal_met'',''callback'',''call_back_later'',''not_interested'','
    || '''gatekeeper'',''gatekeeper_not_interested'',''transferred_to_human'','
    || '''language_barrier'',''hung_up_immediately'',''hung_up_later'',''dnc'')';
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
