"use server";

import { fetchAllMatchingLeadIds as fetchAllIds } from "@/lib/leads/fetch-all-ids";
import { createClient } from "@/lib/supabase/server";

import type { SearchParams } from "./leads-url";

/** Returns every lead id matching the current filter set, ignoring
 *  pagination. Used by the leads-page "Select all N matching" banner so the
 *  user can act on the whole result, not just the visible page or the first
 *  1,000 rows (PostgREST's per-response cap). Delegates the keyset paging to
 *  the shared `fetch-all-ids` helper. */
export async function fetchAllMatchingLeadIds(
  params: SearchParams,
): Promise<{ ids: string[]; truncated: boolean; error: string | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ids: [], truncated: false, error: "Not signed in." };

  return fetchAllIds(supabase, params);
}
