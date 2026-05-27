"use server";

import { createClient } from "@/lib/supabase/server";

import { buildLeadsQuery } from "./leads-query";
import type { SearchParams } from "./leads-url";

/** Maximum leads we'll allow in a single "select all matching" sweep.
 *  Bulk actions on > a few thousand rows are rarely the right move and
 *  this caps the worst-case server work. */
const MAX_MATCH_ALL = 5000;

/** Returns every lead id matching the current filter set, ignoring
 *  pagination. Used by the leads-page "Select all N matching" banner
 *  so the user can act on the whole result, not just the visible page. */
export async function fetchAllMatchingLeadIds(
  params: SearchParams,
): Promise<{ ids: string[]; truncated: boolean; error: string | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ids: [], truncated: false, error: "Not signed in." };

  const { data, error } = await buildLeadsQuery(supabase, params)
    .order("id", { ascending: true })
    .limit(MAX_MATCH_ALL);

  if (error) return { ids: [], truncated: false, error: error.message };

  const rows = data ?? [];
  return {
    ids: rows.map((r) => r.id),
    truncated: rows.length >= MAX_MATCH_ALL,
    error: null,
  };
}
