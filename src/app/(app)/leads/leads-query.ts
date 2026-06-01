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
  "id, company, business_phone, business_email, status, last_outcome, city, state, conversations, call_attempts, last_call_at, next_call_at, owner_id, list_id, ai_summary, created_at, list:lists(name)";

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

/**
 * Build a Supabase leads query with the Leads page search and filters
 * applied. Shared by the Leads table and the CSV export so the two always
 * agree on what "the current view" means.
 */
export function buildLeadsQuery(
  supabase: SupabaseServerClient,
  params: SearchParams,
) {
  let query = supabase
    .from("leads")
    .select(LEADS_SELECT, { count: "exact" })
    .is("deleted_at", null);

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
  if (str(params.outcome)) {
    query = query.eq("last_outcome", str(params.outcome));
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
