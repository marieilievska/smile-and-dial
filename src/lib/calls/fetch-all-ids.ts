import type { createClient } from "@/lib/supabase/server";

import {
  applyCallFilters,
  isUnreviewedOnly,
  resolveLeadFilterIds,
  str,
} from "@/app/(app)/calls/calls-query";
import type { SearchParams } from "@/app/(app)/calls/calls-url";
import { resolveReviewFlagCallIds } from "@/lib/review/calls-filter";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/** PostgREST caps any single response at 1,000 rows regardless of the limit we
 *  ask for, so a plain `.limit(50000)` silently returns only the first 1,000.
 *  We page through the full result set with keyset pagination on `id` instead,
 *  a page at a time, until a short page tells us we've reached the end. */
const PAGE_SIZE = 1000;

/** Hard ceiling on a single all-matching sweep. `truncated` is only ever true
 *  when we actually hit this — i.e. there are genuinely more matches than we'll
 *  act on. */
export const FETCH_ALL_HARD_CAP = 50000;

/**
 * Fetch the ids of EVERY call matching the current Calls-page filters, ignoring
 * pagination and paging past PostgREST's 1,000-row response cap with keyset
 * pagination on `id` (order by id asc, then `.gt("id", lastId)` for the next
 * page). Stops when a page returns fewer than `PAGE_SIZE` rows (the natural end)
 * or when the hard cap is reached.
 *
 * Shares `applyCallFilters` + `resolveLeadFilterIds` with the Calls table so
 * the table, the sweep, and any bulk action all agree on what "the current
 * view" means. Returns `{ ids, truncated, error }`.
 */
export async function fetchAllMatchingCallIds(
  supabase: SupabaseServerClient,
  params: SearchParams,
): Promise<{ ids: string[]; truncated: boolean; error: string | null }> {
  // Search + owner are pre-resolved to lead ids the same way the page does it.
  const leadFilterIds = await resolveLeadFilterIds(supabase, params);

  // Review-bucket filter: scope the sweep to the same calls the table shows so
  // "select all N matching" (and any bulk action on it) stays inside the bucket
  // — and honours the unreviewed-only default. Without this the sweep would
  // ignore review_flag and select the whole (unfiltered) result set.
  const reviewFlag = str(params.review_flag);
  const reviewCallIds = reviewFlag
    ? await resolveReviewFlagCallIds(supabase, reviewFlag, {
        unreviewedOnly: isUnreviewedOnly(params),
      })
    : null;

  const ids: string[] = [];
  let lastId: string | null = null;

  for (;;) {
    let query = applyCallFilters(
      supabase.from("calls").select("id"),
      params,
      leadFilterIds ?? undefined,
      reviewCallIds ?? undefined,
    ).order("id", { ascending: true });
    if (lastId !== null) query = query.gt("id", lastId);

    const { data, error } = await query.limit(PAGE_SIZE);
    if (error) return { ids: [], truncated: false, error: error.message };

    const page = (data ?? []) as { id: string }[];
    for (const row of page) ids.push(row.id);

    if (page.length < PAGE_SIZE) break;
    if (ids.length >= FETCH_ALL_HARD_CAP) {
      return {
        ids: ids.slice(0, FETCH_ALL_HARD_CAP),
        truncated: true,
        error: null,
      };
    }
    lastId = page[page.length - 1].id;
  }

  return { ids, truncated: false, error: null };
}
