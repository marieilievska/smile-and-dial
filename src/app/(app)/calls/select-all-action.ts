"use server";

import { isDenied, requireUserManager } from "@/lib/auth/guards";
import { fetchAllMatchingCallIds as fetchAllIds } from "@/lib/calls/fetch-all-ids";
import { createClient } from "@/lib/supabase/server";

import type { SearchParams } from "./calls-url";

/** Returns every call id matching the current Calls filters, ignoring
 *  pagination. Backs the Calls "Select all N matching" banner so an admin can
 *  bulk-delete the whole filtered result (e.g. clearing test calls), not just
 *  the visible page or the first 1,000 rows (PostgREST's per-response cap).
 *  Admin tier (admin or super admin), matching the rest of calls bulk
 *  selection. deleteCalls then refuses any call the caller doesn't own. */
export async function fetchAllMatchingCallIds(
  params: SearchParams,
): Promise<{ ids: string[]; truncated: boolean; error: string | null }> {
  const supabase = await createClient();
  const auth = await requireUserManager(supabase);
  if (isDenied(auth)) {
    return { ids: [], truncated: false, error: auth.error };
  }

  return fetchAllIds(supabase, params);
}
