import type { RecipeNode } from "@/lib/smart-lists/recipe";
import { parseRecipeParam } from "@/lib/smart-lists/resolve";
import type { Json } from "@/lib/supabase/database.types";
import { fetchAllRows } from "@/lib/supabase/fetch-all-rows";
import type { createClient } from "@/lib/supabase/server";
import { endOfEtDayUtcIso, etDayRangeUtc } from "@/lib/time/eastern";

import { LEAD_COLUMNS } from "./columns";
import type { SearchParams } from "./leads-url";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Columns selected for both the Leads table and the CSV export. Kept as a
 * single string literal so Supabase can infer the row type from it.
 */
export const LEADS_SELECT =
  "id, company, business_phone, business_email, status, category, decision_maker_reached, city, state, timezone, conversations, call_attempts, last_call_at, next_call_at, owner_id, list_id, created_at, list:lists(name)";

/** Valid sort keys: every sortable column plus the default created_at. */
export const SORT_KEYS = new Set<string>([
  ...LEAD_COLUMNS.map((c) => c.sortKey).filter((key): key is string =>
    Boolean(key),
  ),
  "created_at",
]);

/** Read a single string value from Next.js search params. */
export function str(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

/** Resolve the sort column and direction from search params. */
export function parseSort(params: SearchParams): {
  sort: string;
  dir: "asc" | "desc";
} {
  const sort = SORT_KEYS.has(str(params.sort))
    ? str(params.sort)
    : "created_at";
  const dir: "asc" | "desc" = params.dir === "asc" ? "asc" : "desc";
  return { sort, dir };
}

/** True when the Leads view is filtered to "has at least one call attempt". */
export function calledFilterActive(params: SearchParams): boolean {
  return str(params.called) === "yes";
}

/**
 * The active advanced-filter recipe from the URL, or null when there's no
 * effective recipe (absent, unparseable, or an empty top-level group).
 *
 * The recipe is applied DB-side by the query SOURCE (`leadsFilterSource` /
 * `leadsIdSource` → the `leads_matching_filter_rows` function), NOT resolved to
 * a lead-id list. Passing thousands of matching ids to `.in("id", …)` overflowed
 * the request URL (HTTP 414 "Request-URI Too Large") once a filter matched a few
 * hundred leads, so the Leads page silently returned nothing at scale. The
 * "Connected" filter is likewise applied DB-side, as a PostgREST inner-join
 * embed (see `applyLeadFilters`).
 */
export function activeRecipe(params: SearchParams): RecipeNode | null {
  const recipe = parseRecipeParam(str(params.recipe));
  if (!recipe) return null;
  if ("children" in recipe && recipe.children.length === 0) return null;
  return recipe;
}

/**
 * id-only base query for Leads scans (prev/next siblings, select-all/export):
 * the recipe applied DB-side via the `leads_matching_filter_rows` RPC source
 * when active, else the `leads` table. The row shape is id-only, so a runtime
 * `select` string is fine. Any column used in a later `.order(...)` must also
 * appear in `select` — over the RPC source PostgREST rejects ordering by an
 * unselected column.
 */
export function leadsIdSource(
  supabase: SupabaseServerClient,
  params: SearchParams,
  select: string,
) {
  const recipe = activeRecipe(params);
  const base = recipe
    ? supabase
        .rpc("leads_matching_filter_rows", {
          in_recipe: recipe as unknown as Json,
        })
        .select(select)
    : supabase.from("leads").select(select);
  return base.is("deleted_at", null);
}

/** Apply the Leads page search + filters to any leads query builder,
 *  whatever its `.select(...)` is. Generic over the builder type so it works
 *  for the full-row table query and the id-only sibling query alike, keeping
 *  "the current view" defined in exactly one place. */
export function applyLeadFilters<
  Q extends {
    or(filter: string): Q;
    eq(column: string, value: string): Q;
    gte(column: string, value: string): Q;
    lte(column: string, value: string): Q;
  },
>(query: Q, params: SearchParams): Q {
  // Both the advanced-filter recipe and the "Called" filter are applied DB-side
  // by the query SOURCE, never as filters here: the recipe via
  // `leads_matching_filter_rows` (see `buildLeadsQuery`/`leadsIdSource`), and
  // "Called" (≥1 call attempt) via the `_call:calls!inner(id)` inner-join embed
  // the caller adds to its SELECT. Keeping both off the request URL is what fixed
  // the giant `.in("id", …)` the server rejected (HTTP 414) at scale.

  // Search across company, phone, and email.
  const search = str(params.q);
  if (search) {
    const safe = search.replace(/[%,()\\*]/g, "").trim();
    if (safe) {
      query = query.or(
        `company.ilike.%${safe}%,business_phone.ilike.%${safe}%,` +
          `business_email.ilike.%${safe}%`,
      );
    }
  }

  // Filters.
  const listId = str(params.list);
  if (/^[0-9a-f-]{36}$/i.test(listId)) query = query.eq("list_id", listId);
  if (str(params.status)) query = query.eq("status", str(params.status));
  if (str(params.timezone)) {
    query = query.eq("timezone", str(params.timezone));
  }
  const dateFilters: [string, string, string][] = [
    ["created_from", "created_to", "created_at"],
    ["lastcall_from", "lastcall_to", "last_call_at"],
    ["nextcall_from", "nextcall_to", "next_call_at"],
  ];
  for (const [fromKey, toKey, column] of dateFilters) {
    const from = str(params[fromKey]);
    const to = str(params[toKey]);
    // Date filters bound by Eastern calendar day (timestamptz columns).
    if (DATE_RE.test(from))
      query = query.gte(column, etDayRangeUtc(from).startUtc);
    if (DATE_RE.test(to)) query = query.lte(column, endOfEtDayUtcIso(to));
  }

  return query;
}

/**
 * Build a Supabase leads query with the Leads page search and filters
 * applied. Shared by the Leads table and the CSV export so the two always
 * agree on what "the current view" means.
 */
export function buildLeadsQuery(
  supabase: SupabaseServerClient,
  params: SearchParams,
) {
  // Source: the advanced-filter recipe applied DB-side via
  // `leads_matching_filter_rows` when active, else the `leads` table. Count is
  // requested on the source — its placement differs between the RPC (3rd arg)
  // and the table (`.select` options). When the Called filter is on, the SELECT
  // carries an inner-join embed on `calls` so only leads with ≥1 call attempt
  // come back. Each branch keeps a literal SELECT so Supabase infers the row
  // type.
  const recipe = activeRecipe(params);
  const args = recipe ? { in_recipe: recipe as unknown as Json } : null;
  const base = calledFilterActive(params)
    ? args
      ? supabase
          .rpc("leads_matching_filter_rows", args, { count: "exact" })
          .select(`${LEADS_SELECT}, _call:calls!inner(id)`)
      : supabase
          .from("leads")
          .select(`${LEADS_SELECT}, _call:calls!inner(id)`, { count: "exact" })
    : args
      ? supabase
          .rpc("leads_matching_filter_rows", args, { count: "exact" })
          .select(LEADS_SELECT)
      : supabase.from("leads").select(LEADS_SELECT, { count: "exact" });
  return applyLeadFilters(base.is("deleted_at", null), params);
}

/** Most leads we'll scan to locate a lead's neighbours for prev/next on the
 *  detail page. Matches the "select all matching" cap; a lead past it simply
 *  gets no prev/next (a rare edge for very large filtered sets). */
export const SIBLING_SCAN_LIMIT = 5000;

export type LeadSiblings = {
  prevId: string | null;
  nextId: string | null;
  /** 0-based position of the current lead in the filtered+sorted set, or -1
   *  if it isn't in the set (e.g. it no longer matches the filters). */
  index: number;
  /** How many leads were scanned (the position denominator). */
  total: number;
  /** True when the scan hit the cap, so `total`/position understate reality. */
  capped: boolean;
};

/**
 * Find the lead immediately before and after `currentId` in the SAME order
 * and filtering the Leads list uses, so the detail page can offer prev/next
 * that walk the user's current view across page boundaries. Returns id-only
 * rows (cheap) ordered identically to the list — primary sort then id, the
 * same stable tie-break the table applies.
 */
export async function fetchLeadSiblings(
  supabase: SupabaseServerClient,
  params: SearchParams,
  currentId: string,
): Promise<LeadSiblings> {
  const { sort, dir } = parseSort(params);
  // Select `id` plus the sort column: over the recipe RPC source, PostgREST
  // rejects ordering by a column that isn't selected. (`id` is always present.)
  const sortCols = sort === "id" ? "id" : `id, ${sort}`;
  const select = calledFilterActive(params)
    ? `${sortCols}, _call:calls!inner(id)`
    : sortCols;
  // Paged up to the scan cap: a bare `.limit(5000)` was clamped to 1,000 by
  // PostgREST, so "N of M" maxed at 1,000 and `capped` could never fire.
  const data = await fetchAllRows<{ id: string }>(
    (from, to) =>
      applyLeadFilters(leadsIdSource(supabase, params, select), params)
        .order(sort, { ascending: dir === "asc" })
        .order("id", { ascending: true })
        .range(from, to)
        .then((r) => ({ data: r.data as unknown as { id: string }[] | null })),
    { max: SIBLING_SCAN_LIMIT },
  );

  const ids = data.map((r) => r.id);
  const total = ids.length;
  const capped = total >= SIBLING_SCAN_LIMIT;
  const index = ids.indexOf(currentId);
  if (index === -1) {
    return { prevId: null, nextId: null, index: -1, total, capped };
  }
  return {
    prevId: index > 0 ? ids[index - 1] : null,
    nextId: index < total - 1 ? ids[index + 1] : null,
    index,
    total,
    capped,
  };
}
