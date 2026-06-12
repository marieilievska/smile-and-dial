"use server";

import { fetchAllMatchingCallIds as fetchAllIds } from "@/lib/calls/fetch-all-ids";
import { createClient } from "@/lib/supabase/server";

import type { SearchParams } from "./calls-url";

/** Returns every call id matching the current Calls filters, ignoring
 *  pagination. Backs the Calls "Select all N matching" banner so an admin can
 *  bulk-delete the whole filtered result (e.g. clearing test calls), not just
 *  the visible page or the first 1,000 rows (PostgREST's per-response cap).
 *  Admin-only, matching the rest of calls bulk selection. */
export async function fetchAllMatchingCallIds(
  params: SearchParams,
): Promise<{ ids: string[]; truncated: boolean; error: string | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ids: [], truncated: false, error: "Not signed in." };

  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") {
    return { ids: [], truncated: false, error: "Admins only." };
  }

  return fetchAllIds(supabase, params);
}
