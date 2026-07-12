import type { SupabaseClient } from "@supabase/supabase-js";

/** Statuses that mean the dialer has a call in flight right now. Kept in
 *  one place so every "is anything live?" check stays in sync. */
export const ACTIVE_CALL_STATUSES = [
  "queued",
  "dialing",
  "ringing",
  "in_progress",
] as const;

/** True when at least one call is in flight right now. Drives the faster
 *  "active" cadence of <AutoRefresh> on live pages — we only poll quickly
 *  while dialing is actually happening. Cheap: a single head count against
 *  the indexed status column (RLS scopes it to calls the user can see, which
 *  is exactly what we want the cadence to follow). */
export async function hasActiveCalls(
  supabase: SupabaseClient,
): Promise<boolean> {
  const { count } = await supabase
    .from("calls")
    .select("id", { count: "exact", head: true })
    .in("status", ACTIVE_CALL_STATUSES as unknown as string[]);
  return (count ?? 0) > 0;
}
