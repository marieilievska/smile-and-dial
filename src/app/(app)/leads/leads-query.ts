import { resolveRecipeIds } from "@/lib/smart-lists/resolve";
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
  "id, company, business_phone, business_email, status, category, decision_maker_reached, city, state, timezone, conversations, call_attempts, last_call_at, next_call_at, owner_id, list_id, ai_summary, created_at, list:lists(name)";

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
 * The lead-id restriction for the Leads view: the advanced-filter recipe (smart
 * lists), if active. Returns null when no recipe is active (don't constrain).
 *
 * NOTE: the "Connected" filter is deliberately NOT resolved to ids here — it's
 * applied DB-side as a PostgREST inner-join embed (see `applyLeadFilters` +
 * `buildLeadsQuery`). Resolving it to ids and passing them to `.in("id", …)`
 * overflowed the request URL once a few hundred leads qualified (≈639 ids →
 * a 23 KB URL the server rejects), so the filter silently returned nothing.
 */
export async function resolveRestrictLeadIds(
  supabase: SupabaseServerClient,
  params: SearchParams,
): Promise<string[] | null> {
  return resolveRecipeIds(supabase, str(params.recipe));
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
    in(column: string, values: readonly string[]): Q;
  },
>(query: Q, params: SearchParams, restrictLeadIds: string[] | null = null): Q {
  // Id-set restriction (the advanced-filter recipe): the caller resolves the
  // matching lead ids and passes them in. null = no restriction; [] = a
  // restriction that matched nothing → zero rows.
  if (restrictLeadIds !== null) query = query.in("id", restrictLeadIds);

  // The "Called" filter (≥1 call attempt) is applied purely by the inner-join
  // embed the caller adds to its SELECT (`_call:calls!inner(id)`): an inner join
  // returns only leads that have a related call. Done DB-side so we never build a
  // giant id-list URL (the bug that made this filter return nothing at scale).
  // No outcome filter — any call counts.

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
  restrictLeadIds: string[] | null = null,
) {
  // When the Called filter is on, the SELECT carries an inner-join embed on
  // `calls` so only leads with ≥1 call attempt come back. The two branches keep
  // their literal SELECT so Supabase still infers the row type.
  const query = calledFilterActive(params)
    ? supabase
        .from("leads")
        .select(`${LEADS_SELECT}, _call:calls!inner(id)`, { count: "exact" })
        .is("deleted_at", null)
    : supabase
        .from("leads")
        .select(LEADS_SELECT, { count: "exact" })
        .is("deleted_at", null);
  return applyLeadFilters(query, params, restrictLeadIds);
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
  const restrictLeadIds = await resolveRestrictLeadIds(supabase, params);
  const base = calledFilterActive(params)
    ? supabase
        .from("leads")
        .select("id, _call:calls!inner(id)")
        .is("deleted_at", null)
    : supabase.from("leads").select("id").is("deleted_at", null);
  const { data } = await applyLeadFilters(base, params, restrictLeadIds)
    .order(sort, { ascending: dir === "asc" })
    .order("id", { ascending: true })
    .limit(SIBLING_SCAN_LIMIT);

  const ids = (data ?? []).map((r) => (r as { id: string }).id);
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
