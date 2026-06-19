import type { createClient } from "@/lib/supabase/server";

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
    if (DATE_RE.test(from)) query = query.gte(column, from);
    if (DATE_RE.test(to)) query = query.lte(column, `${to}T23:59:59`);
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
  const query = supabase
    .from("leads")
    .select(LEADS_SELECT, { count: "exact" })
    .is("deleted_at", null);
  return applyLeadFilters(query, params);
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
  const base = supabase.from("leads").select("id").is("deleted_at", null);
  const { data } = await applyLeadFilters(base, params)
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
