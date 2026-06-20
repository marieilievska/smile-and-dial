# Smart Lists + Advanced Filters — Release 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a nested AND/OR advanced lead filter to the Leads page (full field catalog incl. custom fields), with live results + count, export of the filtered set, and "Save as Smart List" — powered by one safe Postgres function that returns matching lead IDs.

**Architecture:** A filter "recipe" is a JSONB tree (groups with `and`/`or` combinator + condition leaves). A single Postgres function `leads_matching_filter(recipe jsonb)` translates the tree into a parameterized predicate (allow-listed fields/operators, `format()` quoting, `EXISTS` subqueries for custom-field and call-activity conditions) and returns matching `leads.id`. The Leads page evaluates the active recipe to IDs, then restricts the normal leads query with `.in("id", ids)` — the same proven shape as the existing "Connected" filter. Recipes can be saved to a new `smart_lists` table.

**Tech Stack:** Next.js 16 App Router (server components + server actions), Supabase/Postgres (plpgsql function + RLS), TypeScript, Tailwind v4 + shadcn/ui. Verification in this repo is `npx tsc --noEmit` + `npx eslint` + `npm run build` (no unit-test CI — Playwright CI was removed; the DB function is verified with SQL count checks). Each task commits on a feature branch; the whole release merges via PR(s).

**Scope:** Release 1 only. Deferred to Release 2 (separate plan): `smart_list_members` cache, the few-minute refresh cron, `campaigns.smart_list_id`, and the `dial_queue` third branch.

---

## File structure (Release 1)

- Create `src/lib/smart-lists/recipe.ts` — recipe TYPES, the field/operator CATALOG, and `validateRecipe()` (pure, shared by client + server).
- Create `src/lib/smart-lists/actions.ts` — server actions: `matchingLeadIds(recipe)`, `saveSmartList`, `listSmartLists`, `deleteSmartList` (admin-checked).
- Create `supabase/migrations/<ts>_create_smart_lists.sql` — `smart_lists` table + admin RLS.
- Create `supabase/migrations/<ts>_leads_matching_filter_fn.sql` — the `leads_matching_filter` + `_smart_list_node_sql` Postgres functions.
- Modify `src/app/(app)/leads/leads-query.ts` — accept an optional `restrictLeadIds` already exists; add recipe→IDs resolution wiring at the page level.
- Create `src/app/(app)/leads/filter-builder.tsx` — the nested group/condition builder (client).
- Modify `src/app/(app)/leads/page.tsx` — render the builder, resolve recipe→IDs, pass to the query, show count, Save-as-Smart-List.
- Modify `src/app/(app)/leads/export/route.ts` — honor the recipe (export the filtered set).
- Modify `src/lib/supabase/database.types.ts` — regenerated after migrations.

---

## Task 1: Recipe types + field/operator catalog + validation

**Files:**

- Create: `src/lib/smart-lists/recipe.ts`

- [ ] **Step 1: Write `recipe.ts` with types, catalog, and validation**

```ts
// The saved "recipe" for an advanced lead filter: a tree of AND/OR groups and
// condition leaves. Shared by the client builder and the server evaluator.

export type Combinator = "and" | "or";

export type ConditionOperator =
  | "is"
  | "is_any_of"
  | "is_not"
  | "is_none_of"
  | "contains"
  | "not_contains"
  | "is_empty"
  | "has_value"
  | "eq"
  | "neq"
  | "gt"
  | "lt"
  | "between"
  | "before"
  | "after"
  | "in_last_days"
  | "is_true"
  | "is_false";

export type Condition = {
  /** Field key from FIELD_CATALOG, or `custom:<slug>` for a custom field. */
  field: string;
  operator: ConditionOperator;
  /** string for single-value ops; string[] for is_any_of/between; unused for
   *  is_empty/has_value/is_true/is_false. */
  value?: string | string[];
};

export type Group = { combinator: Combinator; children: RecipeNode[] };
export type RecipeNode = Group | Condition;

export function isGroup(n: RecipeNode): n is Group {
  return (n as Group).combinator !== undefined;
}

/** Logical value type of a field, which determines its operator set + input. */
export type FieldKind = "enum" | "text" | "number" | "date" | "flag";

export type FieldDef = {
  key: string;
  label: string;
  kind: FieldKind;
  /** For enum fields rendered from a fixed set (status, owner is dynamic). */
  options?: { value: string; label: string }[];
};

export const OPERATORS_BY_KIND: Record<FieldKind, ConditionOperator[]> = {
  enum: ["is_any_of", "is_none_of", "is_empty", "has_value"],
  text: ["contains", "not_contains", "is", "is_empty", "has_value"],
  number: ["eq", "neq", "gt", "lt", "between", "is_empty"],
  date: ["before", "after", "between", "in_last_days", "is_empty"],
  flag: ["is_true", "is_false"],
};

export const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  is: "is",
  is_any_of: "is any of",
  is_not: "is not",
  is_none_of: "is none of",
  contains: "contains",
  not_contains: "doesn't contain",
  is_empty: "is empty",
  has_value: "has any value",
  eq: "=",
  neq: "≠",
  gt: ">",
  lt: "<",
  between: "between",
  before: "before",
  after: "after",
  in_last_days: "in last N days",
  is_true: "is yes",
  is_false: "is no",
};

/** Built-in (non-custom) fields. Status + owner OPTIONS are injected at runtime
 *  (status values + the owner list come from the page). */
export const BASE_FIELDS: FieldDef[] = [
  { key: "status", label: "Lead status", kind: "enum" },
  { key: "connected", label: "Connected (ever)", kind: "flag" },
  { key: "goal_met", label: "Goal met", kind: "flag" },
  { key: "dm_reached", label: "Decision maker reached", kind: "flag" },
  { key: "attempts", label: "# of attempts", kind: "number" },
  { key: "last_called", label: "Last called", kind: "date" },
  { key: "created_at", label: "Created date", kind: "date" },
  { key: "city", label: "City", kind: "text" },
  { key: "state", label: "State", kind: "text" },
  { key: "timezone", label: "Timezone", kind: "text" },
  { key: "owner_id", label: "Owner", kind: "enum" },
];

/** A custom field becomes a field with key `custom:<slug>`. select→enum,
 *  number→number, date→date, boolean→flag, everything else→text. */
export function customFieldKind(type: string): FieldKind {
  if (type === "select") return "enum";
  if (type === "number") return "number";
  if (type === "date") return "date";
  if (type === "boolean") return "flag";
  return "text";
}

const SLUG_RE = /^[a-z0-9_]+$/;
const VALID_OPS = new Set<string>(Object.keys(OPERATOR_LABELS));

/** Reject malformed recipes (defense in depth — the SQL function also
 *  allow-lists). Returns null if valid, else an error string. Empty groups are
 *  allowed and treated as "match all". Caps depth + node count. */
export function validateRecipe(node: RecipeNode, depth = 0): string | null {
  if (depth > 6) return "Filter is nested too deeply.";
  if (isGroup(node)) {
    if (node.combinator !== "and" && node.combinator !== "or")
      return "Bad group type.";
    if (node.children.length > 50) return "Too many conditions.";
    for (const child of node.children) {
      const err = validateRecipe(child, depth + 1);
      if (err) return err;
    }
    return null;
  }
  if (typeof node.field !== "string") return "Condition missing field.";
  if (node.field.startsWith("custom:")) {
    if (!SLUG_RE.test(node.field.slice("custom:".length)))
      return "Bad custom field.";
  } else if (!BASE_FIELDS.some((f) => f.key === node.field)) {
    return `Unknown field: ${node.field}`;
  }
  if (!VALID_OPS.has(node.operator))
    return `Unknown operator: ${node.operator}`;
  return null;
}

/** An empty top-level group = no restriction. */
export const EMPTY_RECIPE: Group = { combinator: "and", children: [] };
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep recipe.ts || echo "clean"`
Expected: `clean`

- [ ] **Step 3: Sanity-check validation logic with node**

Run:

```bash
node --input-type=module -e '
import("./src/lib/smart-lists/recipe.ts").catch(()=>{});
' 2>/dev/null; echo "ts not directly runnable — rely on tsc"; \
npx tsc --noEmit 2>&1 | grep -v -E "twilio-(inbound|status-webhook).spec" | head
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/smart-lists/recipe.ts
git commit -m "feat(smart-lists): filter recipe types + field catalog + validation"
```

---

## Task 2: `smart_lists` table migration

**Files:**

- Create: `supabase/migrations/20260619150000_create_smart_lists.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Smart Lists: a saved advanced-filter recipe. Release 1 stores + reuses them
-- for viewing/exporting; Release 2 adds membership cache + campaign attachment.
create table if not exists public.smart_lists (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  description text,
  filter jsonb not null default '{"combinator":"and","children":[]}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.smart_lists is
  'A saved advanced-filter recipe over leads. filter = a JSONB AND/OR tree.';

create index if not exists smart_lists_owner_idx on public.smart_lists (owner_id);

alter table public.smart_lists enable row level security;

-- Admin-managed surface (matches campaigns). Admins do everything; the
-- service role bypasses RLS for the R2 refresh.
create policy "smart_lists_admin_all" on public.smart_lists
  for all to authenticated
  using (public.is_admin((select auth.uid())))
  with check (public.is_admin((select auth.uid())));
```

- [ ] **Step 2: Apply to the linked DB**

Run: `supabase db push --linked`
Expected: `Applying migration 20260619150000_create_smart_lists.sql...` then `Finished supabase db push.`

- [ ] **Step 3: Verify the table exists**

Run:

```bash
URL=$(grep -E "^NEXT_PUBLIC_SUPABASE_URL=" .env.local | cut -d= -f2- | tr -d '"\r'); \
KEY=$(grep -E "^SUPABASE_SERVICE_ROLE_KEY=" .env.local | cut -d= -f2- | tr -d '"\r'); \
curl -s -o /dev/null -w "%{http_code}\n" "$URL/rest/v1/smart_lists?select=id&limit=1" -H "apikey: $KEY" -H "Authorization: Bearer $KEY"
```

Expected: `200`

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260619150000_create_smart_lists.sql
git commit -m "feat(smart-lists): smart_lists table + admin RLS"
```

---

## Task 3: The `leads_matching_filter` Postgres function

**Files:**

- Create: `supabase/migrations/20260619151000_leads_matching_filter_fn.sql`

This is the crux. `_smart_list_node_sql(node)` recursively builds a SQL predicate; `leads_matching_filter(recipe)` runs `select id from leads where <predicate>`. All identifiers/values are quoted with `format()` `%I`/`%L`; fields and operators are allow-listed (unknown → predicate `false`). `security invoker` + `stable`, so leads RLS applies (admin sees all).

- [ ] **Step 1: Write the migration**

```sql
-- Translate a Smart List "recipe" (JSONB AND/OR tree) into a lead-id set.
-- Safe dynamic SQL: allow-listed fields + operators, format() %I/%L quoting.

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
  arr text[];
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

  -- Custom field: custom:<slug>
  if fld like 'custom:%' then
    slug := substr(fld, 8);
    if slug !~ '^[a-z0-9_]+$' then return 'false'; end if;
    return public._smart_list_custom_sql(slug, op, val);
  end if;

  -- Built-in fields.
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
          || 'and c.outcome in (''connected'',''goal_met'',''not_interested'','
          || '''callback'',''call_back_later'',''dnc'',''ai_error'',''gatekeeper''))';
      else
        return 'not exists (select 1 from public.calls c where c.lead_id = l.id '
          || 'and c.outcome in (''connected'',''goal_met'',''not_interested'','
          || '''callback'',''call_back_later'',''dnc'',''ai_error'',''gatekeeper''))';
      end if;
    else
      return 'false';
  end case;
end;
$$;

-- Text/enum operators against a column expression (already-safe expr literal).
create or replace function public._smart_list_text_sql(col text, op text, val jsonb)
returns text
language plpgsql
immutable
as $$
declare arr text[]; s text;
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
      a := (val->>0)::numeric; b := (val->>1)::numeric;
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

-- Date operators (col is timestamptz; values are YYYY-MM-DD, bounded ET-naive).
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
      d := val#>>'{}'; if d is null then return 'false'; end if;
      return format('%s < %L::date', col, d);
    when 'after' then
      d := val#>>'{}'; if d is null then return 'false'; end if;
      return format('%s >= (%L::date + 1)', col, d);
    when 'between' then
      if jsonb_typeof(val) <> 'array' or jsonb_array_length(val) < 2 then
        return 'false';
      end if;
      d := val->>0; d2 := val->>1;
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
  -- Presence operators don't look at the value.
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
  end if;

  -- Value operators: compare the JSON value as text (v.value #>> '{}').
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
    when 'is_none_of' then
      -- handled as "not (is_any_of)" at the EXISTS level below
      if jsonb_typeof(val) <> 'array' then return 'true'; end if;
      select array_agg(quote_literal(x)) into arr
        from jsonb_array_elements_text(val) as x;
      if arr is null then return 'true'; end if;
      return format('not exists (select 1 from public.lead_custom_values v '
        || 'join public.custom_field_defs d on d.id = v.custom_field_id '
        || 'where v.lead_id = l.id and d.slug = %L '
        || 'and (v.value #>> ''{}'') in (%s))', slug, array_to_string(arr, ','));
    else
      return 'false';
  end case;

  return format('exists (select 1 from public.lead_custom_values v '
    || 'join public.custom_field_defs d on d.id = v.custom_field_id '
    || 'where v.lead_id = l.id and d.slug = %L and %s)', slug, inner_cond);
end;
$$;

-- Public entry point: recipe -> matching lead ids. security invoker so leads
-- RLS applies (admin sees all; service role sees all).
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
```

- [ ] **Step 2: Apply to the linked DB**

Run: `supabase db push --linked`
Expected: applies `20260619151000_leads_matching_filter_fn.sql`, `Finished supabase db push.` (a syntax error would fail here.)

- [ ] **Step 3: Verify against live data via RPC (count checks)**

Run (empty recipe = all non-deleted leads; should match the Leads page total):

```bash
URL=$(grep -E "^NEXT_PUBLIC_SUPABASE_URL=" .env.local | cut -d= -f2- | tr -d '"\r'); \
KEY=$(grep -E "^SUPABASE_SERVICE_ROLE_KEY=" .env.local | cut -d= -f2- | tr -d '"\r'); \
echo "empty recipe count:"; \
curl -s "$URL/rest/v1/rpc/leads_matching_filter" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"in_recipe":{"combinator":"and","children":[]}}' | grep -o '"' | wc -l; \
echo "custom 'current_ai_tools has value' count (expect ~149):"; \
curl -s "$URL/rest/v1/rpc/leads_matching_filter" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"in_recipe":{"combinator":"and","children":[{"field":"custom:current_ai_tools","operator":"has_value"}]}}' | tr ',' '\n' | grep -c '[0-9a-f-]\{36\}'
```

Expected: empty-recipe returns many ids; the `has_value` count ≈ 149 (matches the known prod value count). If the second count is 0, debug the custom-field SQL before proceeding.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260619151000_leads_matching_filter_fn.sql
git commit -m "feat(smart-lists): leads_matching_filter Postgres function (recipe -> ids)"
```

---

## Task 4: Regenerate database types

**Files:**

- Modify: `src/lib/supabase/database.types.ts`

- [ ] **Step 1: Regenerate**

Run: `supabase gen types typescript --linked --schema public > src/lib/supabase/database.types.ts`
Expected: file updated; now includes `smart_lists` and the `leads_matching_filter` function.

- [ ] **Step 2: Typecheck (catch any latent nullability drift)**

Run: `npx tsc --noEmit 2>&1 | grep -v -E "twilio-(inbound|status-webhook).spec" | head`
Expected: no NEW errors (only the 3 known pre-existing test errors, which are filtered out).

- [ ] **Step 3: Commit**

```bash
git add src/lib/supabase/database.types.ts
git commit -m "chore(types): regenerate after smart_lists + filter function"
```

---

## Task 5: Server actions (evaluate recipe, save/list/delete smart lists)

**Files:**

- Create: `src/lib/smart-lists/actions.ts`

- [ ] **Step 1: Write the actions**

```ts
"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { validateRecipe, type RecipeNode } from "./recipe";

async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { supabase, ok: false as const };
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  return { supabase, ok: me?.role === "admin", userId: user.id };
}

/** Evaluate a recipe to matching lead ids via the Postgres function. Returns
 *  [] on validation failure (a broken recipe matches nothing, not everything). */
export async function matchingLeadIds(
  recipe: RecipeNode,
): Promise<{ ids: string[]; error: string | null }> {
  const { supabase, ok } = await requireAdmin();
  if (!ok) return { ids: [], error: "Admins only." };
  if (validateRecipe(recipe)) return { ids: [], error: "Invalid filter." };
  const { data, error } = await supabase.rpc("leads_matching_filter", {
    in_recipe: recipe as unknown as never,
  });
  if (error) return { ids: [], error: "Could not run the filter." };
  return {
    ids: ((data ?? []) as { id?: string }[] | string[]).map((r) =>
      typeof r === "string" ? r : (r.id as string),
    ),
    error: null,
  };
}

export async function saveSmartList(input: {
  id?: string;
  name: string;
  description?: string;
  recipe: RecipeNode;
}): Promise<{ error: string | null }> {
  const { supabase, ok } = await requireAdmin();
  if (!ok) return { error: "Admins only." };
  if (!input.name.trim()) return { error: "Name is required." };
  if (validateRecipe(input.recipe)) return { error: "Invalid filter." };
  const row = {
    name: input.name.trim(),
    description: input.description?.trim() || null,
    filter: input.recipe as unknown as never,
    updated_at: new Date().toISOString(),
  };
  const res = input.id
    ? await supabase.from("smart_lists").update(row).eq("id", input.id)
    : await supabase.from("smart_lists").insert(row);
  if (res.error) return { error: "Could not save the smart list." };
  revalidatePath("/leads");
  return { error: null };
}

export async function deleteSmartList(input: {
  id: string;
}): Promise<{ error: string | null }> {
  const { supabase, ok } = await requireAdmin();
  if (!ok) return { error: "Admins only." };
  const { error } = await supabase
    .from("smart_lists")
    .delete()
    .eq("id", input.id);
  if (error) return { error: "Could not delete." };
  revalidatePath("/leads");
  return { error: null };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -v -E "twilio-(inbound|status-webhook).spec" | head`
Expected: clean. (If `supabase.rpc("leads_matching_filter", …)` errors on types, confirm Task 4 regenerated types and the arg name is `in_recipe`.)

- [ ] **Step 3: Lint**

Run: `npx eslint src/lib/smart-lists/actions.ts`
Expected: rc 0.

- [ ] **Step 4: Commit**

```bash
git add src/lib/smart-lists/actions.ts
git commit -m "feat(smart-lists): server actions (evaluate recipe, save/delete)"
```

---

## Task 6: Resolve a recipe in the Leads page query path

The Leads page reads search params and builds the query via `applyLeadFilters(query, params, restrictLeadIds)` (already supports an id restriction — see the "Connected" filter). We pass the recipe through a single param `recipe` (URL-encoded JSON) and resolve it to ids server-side, intersecting with any existing `restrictLeadIds`.

**Files:**

- Modify: `src/app/(app)/leads/page.tsx`
- Modify: `src/app/(app)/leads/export/route.ts`

- [ ] **Step 1: Add a recipe resolver used by both page + export**

Create `src/lib/smart-lists/resolve.ts`:

```ts
import "server-only";

import { matchingLeadIds } from "./actions";
import { EMPTY_RECIPE, type RecipeNode } from "./recipe";

/** Parse the `recipe` search param (URL-encoded JSON). Returns null when absent
 *  or unparseable (caller treats null as "no recipe filter"). */
export function parseRecipeParam(raw: string | undefined): RecipeNode | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RecipeNode;
    return parsed ?? null;
  } catch {
    return null;
  }
}

/** Resolve recipe → lead ids, or null when there's no (effective) recipe. An
 *  empty group means "no restriction" → null. */
export async function resolveRecipeIds(
  raw: string | undefined,
): Promise<string[] | null> {
  const recipe = parseRecipeParam(raw);
  if (!recipe) return null;
  if (
    JSON.stringify(recipe) === JSON.stringify(EMPTY_RECIPE) ||
    ("children" in recipe && recipe.children.length === 0)
  ) {
    return null;
  }
  const { ids } = await matchingLeadIds(recipe);
  return ids;
}
```

- [ ] **Step 2: Wire into `page.tsx` — intersect recipe ids with existing restriction**

In `src/app/(app)/leads/page.tsx`, where `restrictLeadIds` (from the connected filter) is computed, add:

```ts
import { resolveRecipeIds } from "@/lib/smart-lists/resolve";

// ...after computing the existing connected-filter restriction (call it
// `connectedIds: string[] | null`):
const recipeIds = await resolveRecipeIds(str(params.recipe));
// Intersect: null means "no restriction from that source".
const restrictLeadIds =
  connectedIds && recipeIds
    ? connectedIds.filter((id) => new Set(recipeIds).has(id))
    : (recipeIds ?? connectedIds);
```

Pass `restrictLeadIds` to `applyLeadFilters(...)` exactly as today, and use its length for the leads count display. (If both sources are active and the intersection is empty, the page shows 0 — correct.)

- [ ] **Step 3: Wire into `export/route.ts` the same way**

In `src/app/(app)/leads/export/route.ts`, resolve `recipe` from the request URL search params and apply the same intersection to whatever id restriction the export already uses, so the CSV reflects the active filter.

```ts
import { resolveRecipeIds } from "@/lib/smart-lists/resolve";
// const { searchParams } = new URL(request.url);
const recipeIds = await resolveRecipeIds(
  searchParams.get("recipe") ?? undefined,
);
// intersect with existing restriction (mirror page.tsx), then pass to applyLeadFilters.
```

- [ ] **Step 4: Typecheck + lint + build**

Run:

```bash
npx tsc --noEmit 2>&1 | grep -v -E "twilio-(inbound|status-webhook).spec" | head; \
npx eslint "src/app/(app)/leads/page.tsx" "src/app/(app)/leads/export/route.ts" src/lib/smart-lists/resolve.ts; \
npm run build 2>&1 | grep -E "Compiled|Failed|error" | head
```

Expected: tsc clean, eslint rc 0, build "Compiled successfully".

- [ ] **Step 5: Commit**

```bash
git add src/lib/smart-lists/resolve.ts "src/app/(app)/leads/page.tsx" "src/app/(app)/leads/export/route.ts"
git commit -m "feat(smart-lists): resolve recipe -> ids in leads query + export"
```

---

## Task 7: The filter builder UI

**Files:**

- Create: `src/app/(app)/leads/filter-builder.tsx`

A client component: recursive group rendering, condition rows (field → operator → value), All/Any toggle, add/remove. On change it serializes the recipe and pushes it to the URL (`?recipe=<json>`), which re-runs the server query (live results + count). Field options for `status`/`owner_id` and the custom fields are passed in as props from the page.

- [ ] **Step 1: Write the component**

```tsx
"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BASE_FIELDS,
  OPERATORS_BY_KIND,
  OPERATOR_LABELS,
  customFieldKind,
  isGroup,
  type Condition,
  type FieldDef,
  type Group,
  type RecipeNode,
} from "@/lib/smart-lists/recipe";

export type CustomFieldOption = {
  slug: string;
  name: string;
  type: string;
  options: string[];
};

export function FilterBuilder({
  initialRecipe,
  statusOptions,
  ownerOptions,
  customFields,
}: {
  initialRecipe: Group;
  statusOptions: { value: string; label: string }[];
  ownerOptions: { value: string; label: string }[];
  customFields: CustomFieldOption[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [recipe, setRecipe] = useState<Group>(initialRecipe);

  // Full field catalog = base fields (status/owner options injected) + customs.
  const fields = useMemo<FieldDef[]>(() => {
    const base = BASE_FIELDS.map((f) =>
      f.key === "status"
        ? { ...f, options: statusOptions }
        : f.key === "owner_id"
          ? { ...f, options: ownerOptions }
          : f,
    );
    const custom = customFields.map<FieldDef>((c) => ({
      key: `custom:${c.slug}`,
      label: c.name,
      kind: customFieldKind(c.type),
      options:
        c.type === "select"
          ? c.options.map((o) => ({ value: o, label: o }))
          : undefined,
    }));
    return [...base, ...custom];
  }, [statusOptions, ownerOptions, customFields]);

  const fieldByKey = useMemo(
    () => new Map(fields.map((f) => [f.key, f])),
    [fields],
  );

  function apply(next: Group) {
    setRecipe(next);
    const sp = new URLSearchParams(searchParams.toString());
    if (next.children.length === 0) sp.delete("recipe");
    else sp.set("recipe", JSON.stringify(next));
    sp.delete("page"); // reset pagination
    router.push(`/leads?${sp.toString()}`);
  }

  function clearAll() {
    apply({ combinator: "and", children: [] });
  }

  return (
    <div className="border-border bg-card flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">Advanced filter</span>
        {recipe.children.length > 0 ? (
          <button
            type="button"
            onClick={clearAll}
            className="text-muted-foreground hover:text-destructive text-xs"
          >
            Clear all
          </button>
        ) : null}
      </div>
      <GroupEditor
        group={recipe}
        fields={fields}
        fieldByKey={fieldByKey}
        onChange={apply}
        depth={0}
      />
    </div>
  );
}

function GroupEditor({
  group,
  fields,
  fieldByKey,
  onChange,
  depth,
}: {
  group: Group;
  fields: FieldDef[];
  fieldByKey: Map<string, FieldDef>;
  onChange: (g: Group) => void;
  depth: number;
}) {
  function setChild(i: number, node: RecipeNode) {
    const children = group.children.slice();
    children[i] = node;
    onChange({ ...group, children });
  }
  function removeChild(i: number) {
    onChange({ ...group, children: group.children.filter((_, j) => j !== i) });
  }
  function addCondition() {
    const first = fields[0];
    onChange({
      ...group,
      children: [
        ...group.children,
        {
          field: first.key,
          operator: OPERATORS_BY_KIND[first.kind][0],
          value: "",
        },
      ],
    });
  }
  function addGroup() {
    onChange({
      ...group,
      children: [...group.children, { combinator: "and", children: [] }],
    });
  }

  return (
    <div className={depth > 0 ? "border-border ml-2 border-l pl-3" : ""}>
      <div className="bg-muted/40 mb-2 inline-flex rounded-md p-0.5 text-xs">
        {(["and", "or"] as const).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onChange({ ...group, combinator: c })}
            className={
              "rounded px-2 py-0.5 font-medium " +
              (group.combinator === c
                ? "bg-background shadow-sm"
                : "text-muted-foreground")
            }
          >
            {c === "and" ? "Match ALL" : "Match ANY"}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        {group.children.map((child, i) =>
          isGroup(child) ? (
            <div key={i} className="flex items-start gap-2">
              <GroupEditor
                group={child}
                fields={fields}
                fieldByKey={fieldByKey}
                onChange={(g) => setChild(i, g)}
                depth={depth + 1}
              />
              <RemoveBtn onClick={() => removeChild(i)} />
            </div>
          ) : (
            <ConditionRow
              key={i}
              condition={child}
              fields={fields}
              fieldByKey={fieldByKey}
              onChange={(c) => setChild(i, c)}
              onRemove={() => removeChild(i)}
            />
          ),
        )}
      </div>
      <div className="mt-2 flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={addCondition}
        >
          <Plus className="size-4" /> Add condition
        </Button>
        {depth < 3 ? (
          <Button type="button" size="sm" variant="ghost" onClick={addGroup}>
            <Plus className="size-4" /> Add group
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function RemoveBtn({ onClick }: { onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={onClick}
      aria-label="Remove"
      className="text-muted-foreground hover:text-destructive size-8"
    >
      <Trash2 className="size-4" />
    </Button>
  );
}

function ConditionRow({
  condition,
  fields,
  fieldByKey,
  onChange,
  onRemove,
}: {
  condition: Condition;
  fields: FieldDef[];
  fieldByKey: Map<string, FieldDef>;
  onChange: (c: Condition) => void;
  onRemove: () => void;
}) {
  const field = fieldByKey.get(condition.field) ?? fields[0];
  const ops = OPERATORS_BY_KIND[field.kind];
  const noValue =
    condition.operator === "is_empty" ||
    condition.operator === "has_value" ||
    condition.operator === "is_true" ||
    condition.operator === "is_false";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={condition.field}
        onValueChange={(f) => {
          const nf = fieldByKey.get(f)!;
          onChange({
            field: f,
            operator: OPERATORS_BY_KIND[nf.kind][0],
            value: "",
          });
        }}
      >
        <SelectTrigger className="h-8 w-[12rem]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {fields.map((f) => (
            <SelectItem key={f.key} value={f.key}>
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={condition.operator}
        onValueChange={(op) =>
          onChange({ ...condition, operator: op as Condition["operator"] })
        }
      >
        <SelectTrigger className="h-8 w-[11rem]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ops.map((op) => (
            <SelectItem key={op} value={op}>
              {OPERATOR_LABELS[op]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {!noValue ? (
        <ValueInput field={field} condition={condition} onChange={onChange} />
      ) : null}

      <RemoveBtn onClick={onRemove} />
    </div>
  );
}

function ValueInput({
  field,
  condition,
  onChange,
}: {
  field: FieldDef;
  condition: Condition;
  onChange: (c: Condition) => void;
}) {
  // enum single-or-multi: render a multi-select as comma chips via simple Select
  // for "is", or a basic multiselect for is_any_of/is_none_of.
  const isMulti =
    condition.operator === "is_any_of" || condition.operator === "is_none_of";
  const between = condition.operator === "between";

  if (field.kind === "enum" && field.options) {
    // Multi: store string[]. Render check list inline.
    if (isMulti) {
      const selected = new Set(
        Array.isArray(condition.value) ? condition.value : [],
      );
      return (
        <div className="flex flex-wrap gap-1">
          {field.options.map((o) => {
            const on = selected.has(o.value);
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  const next = new Set(selected);
                  if (on) next.delete(o.value);
                  else next.add(o.value);
                  onChange({ ...condition, value: [...next] });
                }}
                className={
                  "rounded-full border px-2 py-0.5 text-xs " +
                  (on
                    ? "text-foreground border-[color:var(--primary)]"
                    : "border-border text-muted-foreground")
                }
              >
                {o.label}
              </button>
            );
          })}
        </div>
      );
    }
    return (
      <Select
        value={typeof condition.value === "string" ? condition.value : ""}
        onValueChange={(v) => onChange({ ...condition, value: v })}
      >
        <SelectTrigger className="h-8 w-[12rem]">
          <SelectValue placeholder="Choose…" />
        </SelectTrigger>
        <SelectContent>
          {field.options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  const inputType =
    field.kind === "number"
      ? "number"
      : field.kind === "date" && condition.operator !== "in_last_days"
        ? "date"
        : "text";

  if (between) {
    const arr = Array.isArray(condition.value) ? condition.value : ["", ""];
    return (
      <div className="flex items-center gap-1">
        <Input
          type={inputType}
          value={arr[0] ?? ""}
          className="h-8 w-[8rem]"
          onChange={(e) =>
            onChange({ ...condition, value: [e.target.value, arr[1] ?? ""] })
          }
        />
        <span className="text-muted-foreground text-xs">and</span>
        <Input
          type={inputType}
          value={arr[1] ?? ""}
          className="h-8 w-[8rem]"
          onChange={(e) =>
            onChange({ ...condition, value: [arr[0] ?? "", e.target.value] })
          }
        />
      </div>
    );
  }

  return (
    <Input
      type={inputType}
      value={typeof condition.value === "string" ? condition.value : ""}
      placeholder={
        field.kind === "date" && condition.operator === "in_last_days"
          ? "days"
          : ""
      }
      className="h-8 w-[12rem]"
      onChange={(e) => onChange({ ...condition, value: e.target.value })}
    />
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run:

```bash
npx tsc --noEmit 2>&1 | grep -v -E "twilio-(inbound|status-webhook).spec" | head; \
npx eslint "src/app/(app)/leads/filter-builder.tsx"
```

Expected: tsc clean, eslint rc 0.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/leads/filter-builder.tsx"
git commit -m "feat(smart-lists): nested AND/OR filter builder UI"
```

---

## Task 8: Render the builder on the Leads page + count + Save as Smart List

**Files:**

- Modify: `src/app/(app)/leads/page.tsx`
- Create: `src/app/(app)/leads/save-smart-list-button.tsx`

- [ ] **Step 1: Build the field-option inputs in `page.tsx`**

In `src/app/(app)/leads/page.tsx`, before rendering, gather the option lists the builder needs (server-side, admin already verified by the page):

```ts
// Custom fields for the builder (slug/name/type/options).
const { data: cfDefs } = await supabase
  .from("custom_field_defs")
  .select("slug, name, type, options")
  .order("sort_order");
const customFields = (cfDefs ?? []).map((d) => ({
  slug: d.slug,
  name: d.name,
  type: d.type,
  options: Array.isArray(d.options) ? (d.options as string[]) : [],
}));

// Owners (admins can target by owner). Reuse however the page already loads
// users; if none, pass [].
const ownerOptions = owners.map((o) => ({
  value: o.id,
  label: o.full_name ?? o.email ?? o.id,
}));

// Lead statuses — the same set used by the status quick-filter.
const statusOptions = LEAD_STATUS_VALUES.map((s) => ({
  value: s,
  label: humanizeStatus(s),
}));
```

(If `LEAD_STATUS_VALUES`/`humanizeStatus`/`owners` don't already exist on the page, reuse the source the existing status + owner quick-filters use — do not invent a new list.)

- [ ] **Step 2: Render the builder + the live count + Save button**

```tsx
import { FilterBuilder } from "./filter-builder";
import { SaveSmartListButton } from "./save-smart-list-button";
import { parseRecipeParam } from "@/lib/smart-lists/resolve";
import { EMPTY_RECIPE } from "@/lib/smart-lists/recipe";

// recipe for the builder's initial state:
const initialRecipe =
  (parseRecipeParam(str(params.recipe)) as
    | import("@/lib/smart-lists/recipe").Group
    | null) ?? EMPTY_RECIPE;

// In the JSX, above the leads table:
<FilterBuilder
  initialRecipe={initialRecipe}
  statusOptions={statusOptions}
  ownerOptions={ownerOptions}
  customFields={customFields}
/>;
{
  str(params.recipe) ? (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground text-sm">
        {total.toLocaleString()} {total === 1 ? "lead" : "leads"} match
      </span>
      <SaveSmartListButton recipeJson={str(params.recipe)} />
    </div>
  ) : null;
}
```

(`total` is the existing leads count the page already computes from the query; with `restrictLeadIds` applied it reflects the filter.)

- [ ] **Step 3: Write the Save button (client)**

Create `src/app/(app)/leads/save-smart-list-button.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { saveSmartList } from "@/lib/smart-lists/actions";
import type { Group } from "@/lib/smart-lists/recipe";

export function SaveSmartListButton({ recipeJson }: { recipeJson: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, start] = useTransition();

  function save() {
    let recipe: Group;
    try {
      recipe = JSON.parse(recipeJson) as Group;
    } catch {
      toast.error("Filter is invalid.");
      return;
    }
    start(async () => {
      const res = await saveSmartList({ name, recipe });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Smart list saved.");
      setOpen(false);
      setName("");
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          Save as Smart List
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save smart list</DialogTitle>
        </DialogHeader>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Warm — AI interest yes, never called"
        />
        <DialogFooter>
          <Button
            type="button"
            onClick={save}
            disabled={pending || !name.trim()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Typecheck + lint + build**

Run:

```bash
npx tsc --noEmit 2>&1 | grep -v -E "twilio-(inbound|status-webhook).spec" | head; \
npx eslint "src/app/(app)/leads/page.tsx" "src/app/(app)/leads/save-smart-list-button.tsx"; \
npm run build 2>&1 | grep -E "Compiled|Failed|error" | head
```

Expected: tsc clean, eslint rc 0, build "Compiled successfully".

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/leads/page.tsx" "src/app/(app)/leads/save-smart-list-button.tsx"
git commit -m "feat(smart-lists): render filter builder + live count + save on Leads"
```

---

## Task 9: Load + manage saved smart lists on the Leads page

**Files:**

- Create: `src/app/(app)/leads/smart-list-picker.tsx`
- Modify: `src/app/(app)/leads/page.tsx`

- [ ] **Step 1: Fetch saved smart lists in `page.tsx`**

```ts
const { data: smartLists } = await supabase
  .from("smart_lists")
  .select("id, name, filter")
  .order("created_at", { ascending: false });
```

- [ ] **Step 2: Write the picker (client) — load applies the recipe to the URL**

Create `src/app/(app)/leads/smart-list-picker.tsx`:

```tsx
"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { deleteSmartList } from "@/lib/smart-lists/actions";

export function SmartListPicker({
  lists,
  activeRecipeJson,
}: {
  lists: { id: string; name: string; filter: unknown }[];
  activeRecipeJson: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, start] = useTransition();

  const active = lists.find(
    (l) => JSON.stringify(l.filter) === activeRecipeJson,
  );

  function load(id: string) {
    const l = lists.find((x) => x.id === id);
    if (!l) return;
    const sp = new URLSearchParams(searchParams.toString());
    sp.set("recipe", JSON.stringify(l.filter));
    sp.delete("page");
    router.push(`/leads?${sp.toString()}`);
  }

  function remove() {
    if (!active) return;
    start(async () => {
      const res = await deleteSmartList({ id: active.id });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Deleted.");
    });
  }

  if (lists.length === 0) return null;
  return (
    <div className="flex items-center gap-2">
      <Select value={active?.id ?? ""} onValueChange={load}>
        <SelectTrigger className="h-8 w-[16rem]">
          <SelectValue placeholder="Load a smart list…" />
        </SelectTrigger>
        <SelectContent>
          {lists.map((l) => (
            <SelectItem key={l.id} value={l.id}>
              {l.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {active ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={remove}
        >
          Delete
        </Button>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 3: Render the picker next to the builder header in `page.tsx`**

```tsx
import { SmartListPicker } from "./smart-list-picker";
// near the Advanced filter header:
<SmartListPicker
  lists={smartLists ?? []}
  activeRecipeJson={str(params.recipe)}
/>;
```

- [ ] **Step 4: Typecheck + lint + build**

Run:

```bash
npx tsc --noEmit 2>&1 | grep -v -E "twilio-(inbound|status-webhook).spec" | head; \
npx eslint "src/app/(app)/leads/smart-list-picker.tsx" "src/app/(app)/leads/page.tsx"; \
npm run build 2>&1 | grep -E "Compiled|Failed|error" | head
```

Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/leads/smart-list-picker.tsx" "src/app/(app)/leads/page.tsx"
git commit -m "feat(smart-lists): load + delete saved smart lists on Leads"
```

---

## Task 10: Manual end-to-end verification + ship

- [ ] **Step 1: Full local gates**

Run:

```bash
npx tsc --noEmit 2>&1 | grep -v -E "twilio-(inbound|status-webhook).spec" | head; \
npx eslint "src/app/(app)/leads" src/lib/smart-lists; \
npm run build 2>&1 | tail -5
```

Expected: tsc clean (only 3 known test errors filtered), eslint rc 0, build success.

- [ ] **Step 2: Manual smoke (against deployed preview or local dev)**

Verify on the Leads page:

- Add condition `Current AI tools` `has any value` → count ≈ 149; export contains those leads.
- Add a nested group: `Match ALL` [ status `is any of` ready_to_call ] `AND` ( `Match ANY` [ interest `is any of` yes ] [ interest `is any of` maybe ] ) → results look right; count matches table.
- `Last called` `never called` → only never-called leads.
- Save as Smart List "Test"; reload via the picker; delete it.
- Clear all → full list returns.

- [ ] **Step 3: Open the PR + merge**

```bash
gh pr create --base main --head <branch> --title "feat(smart-lists): advanced lead filters + save (Release 1)" --body "Implements Release 1 of the Smart Lists spec: nested AND/OR filter builder on Leads, live results/count, export of the filtered set, Save/load/delete Smart Lists, powered by the leads_matching_filter Postgres function. Release 2 (membership refresh + campaign attach + dialer) is a separate plan."
gh pr merge <branch> --squash --delete-branch
```

- [ ] **Step 4: Verify deploy + count parity**

After deploy, confirm the same recipe returns the same count via the RPC (Task 3 Step 3) and on the live Leads page.

---

## Self-review (against the spec)

**Spec coverage:**

- Nested AND/OR recipe → Task 1 (types) + Task 3 (`_smart_list_node_sql` recursion). ✓
- Full field/operator catalog incl. custom fields → Task 1 catalog + Task 3 per-kind SQL builders + custom EXISTS. ✓
- Live results + count on Leads → Tasks 6 + 8. ✓
- Export the filtered set → Task 6 Step 3. ✓
- Save as Smart List (table + recipe) → Task 2 + Task 5 + Task 8. ✓
- Load/delete saved smart lists → Task 9. ✓
- One safe Postgres function returning ids (allow-list, format quoting, RLS) → Task 3. ✓
- Release 2 deferred → not in plan. ✓

**Placeholder scan:** No TBD/TODO; every code step has real code. Two intentional "reuse existing source" notes (Task 8 Step 1 owners/status, Task 6 Step 3 export intersection) point at concrete existing code rather than inventing parallel lists — verify against the current page before writing.

**Type consistency:** `RecipeNode`/`Group`/`Condition`/`ConditionOperator` defined in Task 1 and used consistently in Tasks 5/6/7/8/9. RPC arg name `in_recipe` consistent (Task 3 fn + Task 5 call + Task 6 resolver). Function name `leads_matching_filter` consistent across Tasks 3/4/5. CONNECTED_OUTCOMES list in Task 3 mirrors `src/lib/calls/outcomes.ts` — confirm the exact set when implementing (the plan inlines it into SQL; if outcomes.ts changes, update the function).

**Known follow-ups to confirm during implementation:**

- The connected-outcomes set is duplicated in SQL (Task 3) — acceptable (DB-side), but note the source of truth is `src/lib/calls/outcomes.ts`.
- The Leads page's existing `restrictLeadIds`/`total`/owner-source variable names must be matched to the actual file (the plan assumes the connected-filter wiring from memory).
