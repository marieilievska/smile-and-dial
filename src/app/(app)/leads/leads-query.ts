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
    in(column: string, values: readonly string[]): Q;
  },
>(query: Q, params: SearchParams, customLeadIds: string[] | null = null): Q {
  // Custom-field filters are resolved to a set of matching lead ids upstream
  // (resolveCustomFieldLeadIds). null = no custom-field filter applied; an empty
  // array = a custom filter that matched nothing, which must yield zero rows.
  if (customLeadIds !== null) query = query.in("id", customLeadIds);
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

/** One parsed custom-field filter. Within a field the picked `values` OR each
 *  other (and OR `present`); across fields the filters AND. `present` = "the
 *  lead has any value collected for this field" (used for free-text fields like
 *  the call reason / current tools, where matching exact text isn't useful). */
export type CustomFilter = { slug: string; values: string[]; present: boolean };

/** Parse the Leads URL's custom-field filter params: `cf_<slug>=v1,v2` (match
 *  any of these collected values — used for enum-like fields) and `cfp_<slug>=1`
 *  (the lead has any value for this field). Grouped by field slug. `cfp_` does
 *  not start with `cf_` (3rd char differs), so the prefix checks don't collide. */
export function parseCustomFilters(params: SearchParams): CustomFilter[] {
  const bySlug = new Map<string, CustomFilter>();
  const ensure = (slug: string): CustomFilter => {
    let f = bySlug.get(slug);
    if (!f) {
      f = { slug, values: [], present: false };
      bySlug.set(slug, f);
    }
    return f;
  };
  for (const [key, raw] of Object.entries(params)) {
    const value = str(raw).trim();
    if (!value) continue;
    if (key.startsWith("cfp_")) {
      const slug = key.slice(4);
      if (slug) ensure(slug).present = true;
    } else if (key.startsWith("cf_")) {
      const slug = key.slice(3);
      if (slug) {
        const vals = value
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean);
        if (vals.length > 0) ensure(slug).values.push(...vals);
      }
    }
  }
  return [...bySlug.values()].filter((f) => f.values.length > 0 || f.present);
}

/** Per-field id-fetch cap. PostgREST returns at most 1,000 rows per request
 *  anyway; custom-field filters are selective (you filter to find a segment),
 *  so a value matching more leads than this is "everyone", not a real filter. */
const CUSTOM_FILTER_CAP = 1000;

/**
 * Resolve the Leads-page custom-field filters to the set of matching lead ids,
 * so the table / export / nav can constrain by `id`. Returns:
 *   - null  → no custom-field filter is applied (don't constrain at all)
 *   - []    → a filter is applied but nothing matched (show zero leads)
 *   - [ids] → the matching lead ids (intersection across fields)
 *
 * Within a field, the picked values and the `contains` substring are OR'd
 * (union); across different fields the matches are AND'd (intersection).
 */
export async function resolveCustomFieldLeadIds(
  supabase: SupabaseServerClient,
  params: SearchParams,
): Promise<string[] | null> {
  const filters = parseCustomFilters(params);
  if (filters.length === 0) return null;

  const { data: defs } = await supabase
    .from("custom_field_defs")
    .select("id, slug")
    .in(
      "slug",
      filters.map((f) => f.slug),
    );
  const idBySlug = new Map<string, string>(
    (defs ?? []).map((d) => [d.slug as string, d.id as string]),
  );

  let acc: Set<string> | null = null;
  for (const f of filters) {
    const fieldId = idBySlug.get(f.slug);
    if (!fieldId) return []; // unknown field → nothing matches
    const matched = new Set<string>();
    if (f.values.length > 0) {
      const { data } = await supabase
        .from("lead_custom_values")
        .select("lead_id")
        .eq("custom_field_id", fieldId)
        .in("value", f.values)
        .limit(CUSTOM_FILTER_CAP);
      for (const r of (data ?? []) as { lead_id: string | null }[]) {
        if (r.lead_id) matched.add(r.lead_id);
      }
    }
    if (f.present) {
      const { data } = await supabase
        .from("lead_custom_values")
        .select("lead_id")
        .eq("custom_field_id", fieldId)
        .not("value", "is", null)
        .limit(CUSTOM_FILTER_CAP);
      for (const r of (data ?? []) as { lead_id: string | null }[]) {
        if (r.lead_id) matched.add(r.lead_id);
      }
    }
    if (acc === null) {
      acc = matched;
    } else {
      // Intersect (AND across fields): keep only ids in both sets.
      const intersection = new Set<string>();
      for (const id of acc) {
        if (matched.has(id)) intersection.add(id);
      }
      acc = intersection;
    }
    if (acc.size === 0) return [];
  }
  return acc === null ? null : [...acc];
}

/**
 * Build a Supabase leads query with the Leads page search and filters
 * applied. Shared by the Leads table and the CSV export so the two always
 * agree on what "the current view" means.
 *
 * Stays SYNCHRONOUS and returns the chainable query builder — the caller
 * resolves `customLeadIds` (via resolveCustomFieldLeadIds) first and passes it
 * in. We can't make this async: a Supabase builder is itself thenable, so
 * returning one from an async function would auto-execute the query instead of
 * handing back the builder to chain `.order()/.range()` on.
 */
export function buildLeadsQuery(
  supabase: SupabaseServerClient,
  params: SearchParams,
  customLeadIds: string[] | null = null,
) {
  const query = supabase
    .from("leads")
    .select(LEADS_SELECT, { count: "exact" })
    .is("deleted_at", null);
  return applyLeadFilters(query, params, customLeadIds);
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
  const customLeadIds = await resolveCustomFieldLeadIds(supabase, params);
  const base = supabase.from("leads").select("id").is("deleted_at", null);
  const { data } = await applyLeadFilters(base, params, customLeadIds)
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
