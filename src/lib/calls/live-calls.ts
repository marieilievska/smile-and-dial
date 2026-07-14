import type { SupabaseClient } from "@supabase/supabase-js";

/** Statuses that mean the dialer has a call in flight right now. Kept in
 *  one place so every "is anything live?" check stays in sync. */
export const ACTIVE_CALL_STATUSES = [
  "queued",
  "dialing",
  "ringing",
  "in_progress",
] as const;

/** A call older than this can't legitimately still be in flight — the stale-call
 *  reaper terminalizes AI calls at 15 min and human calls at 60 min. We bound
 *  "active" by recency so ONE stuck row (e.g. a dropped terminal webhook that
 *  the reaper hasn't swept yet) can't pin every open live tab to the fast poll
 *  cadence indefinitely. 60 min matches the longest legitimate call window, so
 *  no genuinely-live call is ever missed. */
const ACTIVE_RECENCY_MINUTES = 60;

/** True when at least one call is in flight right now (bounded to recently
 *  created calls — see ACTIVE_RECENCY_MINUTES). Drives the faster "active"
 *  cadence of <AutoRefresh> on live pages — we only poll quickly while dialing
 *  is actually happening. Cheap: a single head count against the indexed status
 *  column (RLS scopes it to calls the user can see, which is exactly what we
 *  want the cadence to follow). */
export async function hasActiveCalls(
  supabase: SupabaseClient,
): Promise<boolean> {
  const cutoff = new Date(
    Date.now() - ACTIVE_RECENCY_MINUTES * 60 * 1000,
  ).toISOString();
  const { count } = await supabase
    .from("calls")
    .select("id", { count: "exact", head: true })
    .in("status", ACTIVE_CALL_STATUSES as unknown as string[])
    .gte("created_at", cutoff);
  return (count ?? 0) > 0;
}
