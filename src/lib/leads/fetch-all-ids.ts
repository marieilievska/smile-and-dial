import type { createClient } from "@/lib/supabase/server";

import {
  applyLeadFilters,
  LEADS_SELECT,
  resolveCustomFieldLeadIds,
} from "@/app/(app)/leads/leads-query";
import type { SearchParams } from "@/app/(app)/leads/leads-url";

import { chunk } from "./chunk";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/** PostgREST caps any single response at 1,000 rows regardless of the limit
 *  we ask for, so a plain `.limit(50000)` silently returns only the first
 *  1,000. We page through the full result set with keyset pagination on `id`
 *  instead, a page at a time, until a short page tells us we've reached the
 *  end. */
const PAGE_SIZE = 1000;

/** Hard ceiling on a single all-matching sweep. Bulk actions / exports on far
 *  more than this are rarely the right move and this caps the worst-case
 *  server work. `truncated` is only ever true when we actually hit this. */
export const FETCH_ALL_HARD_CAP = 50000;

/** Rows fetched per request when re-hydrating full lead rows from a list of
 *  ids. Kept under the PostgREST page cap and small enough that the `.in(…)`
 *  filter never overflows the request URL. */
const ROW_FETCH_CHUNK = 500;

/**
 * Fetch the ids of EVERY lead matching the given Leads-page filters, paging
 * past PostgREST's 1,000-row response cap with keyset pagination on `id`
 * (order by id asc, then `.gt("id", lastId)` for the next page). Stops when a
 * page returns fewer than `PAGE_SIZE` rows (the natural end) or when the hard
 * cap is reached.
 *
 * Returns `{ ids, truncated, error }`. `truncated` is true ONLY when the hard
 * cap was actually hit — i.e. there are genuinely more matches than we'll act
 * on — so callers can show an honest "first N of M" message instead of a flag
 * that could never fire under the old `.limit()` approach.
 *
 * Shares `applyLeadFilters` with the Leads table and CSV export so all three
 * agree on what "the current view" means.
 */
export async function fetchAllMatchingLeadIds(
  supabase: SupabaseServerClient,
  params: SearchParams,
): Promise<{ ids: string[]; truncated: boolean; error: string | null }> {
  const ids: string[] = [];
  let lastId: string | null = null;

  // Resolve custom-field filters once up front (not per keyset page).
  const customLeadIds = await resolveCustomFieldLeadIds(supabase, params);

  for (;;) {
    let query = applyLeadFilters(
      supabase.from("leads").select("id").is("deleted_at", null),
      params,
      customLeadIds,
    ).order("id", { ascending: true });
    if (lastId !== null) query = query.gt("id", lastId);

    const { data, error } = await query.limit(PAGE_SIZE);
    if (error) return { ids: [], truncated: false, error: error.message };

    const page = (data ?? []) as { id: string }[];
    for (const row of page) ids.push(row.id);

    // A short page means we've consumed the whole result set.
    if (page.length < PAGE_SIZE) break;

    lastId = page[page.length - 1].id;

    // Stop once we hit the hard cap; trim to exactly the cap and flag it.
    if (ids.length >= FETCH_ALL_HARD_CAP) {
      return {
        ids: ids.slice(0, FETCH_ALL_HARD_CAP),
        truncated: true,
        error: null,
      };
    }
  }

  return { ids, truncated: false, error: null };
}

/**
 * Re-hydrate full lead rows (LEADS_SELECT shape) for a list of ids, fetching
 * in chunks so neither the request URL nor PostgREST's response cap is a
 * problem. Order is not guaranteed across chunks — callers that need a
 * specific order should sort the returned rows themselves.
 */
export async function fetchLeadRowsByIds(
  supabase: SupabaseServerClient,
  ids: string[],
): Promise<{ rows: Record<string, unknown>[]; error: string | null }> {
  const rows: Record<string, unknown>[] = [];
  for (const idChunk of chunk(ids, ROW_FETCH_CHUNK)) {
    const { data, error } = await supabase
      .from("leads")
      .select(LEADS_SELECT)
      .in("id", idChunk);
    if (error) return { rows: [], error: error.message };
    rows.push(...((data ?? []) as Record<string, unknown>[]));
  }
  return { rows, error: null };
}
