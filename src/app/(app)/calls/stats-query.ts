import { CONNECTED_OUTCOMES } from "@/lib/calls/outcomes";
import type { createClient } from "@/lib/supabase/server";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export type CallStats = {
  callsToday: number;
  connectRateToday: number;
  goalMetToday: number;
  /** Calls the dialer is actively working *right now* (queued through
   *  in_progress). Drives the live "N in progress" pulse in the page
   *  header so Calls reads as a live operation, not a log. */
  inProgressNow: number;
};

/** Statuses that mean a call is live on the wire right now. Kept in
 *  sync with ACTIVE_STATUSES in columns.tsx (which drives the per-row
 *  pulse). */
const ACTIVE_STATUSES = [
  "queued",
  "dialing",
  "ringing",
  "in_progress",
] as const;

/** Compute the 3-stat strip shown under the /calls page header.
 *  Read-only — every stat is "today so far" against the server clock.
 *  Heavy lifting is one query (today's calls), then map+reduce in JS.
 *
 *  Round 30 — dropped the spend column (D3, 4→3). The /costs page is
 *  the proper home for financial signals; mirroring it here was
 *  duplication. */
export async function fetchCallStats(
  supabase: SupabaseServerClient,
): Promise<CallStats> {
  // UTC day start — consistent with the Today/Costs pages and the UTC server.
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);

  const [{ data, error }, { count: inProgressCount }] = await Promise.all([
    supabase
      .from("calls")
      .select("outcome, goal_met")
      .gte("started_at", startOfToday.toISOString())
      .limit(5000),
    // Live count is status-driven, not date-bound: a call queued
    // yesterday that's still ringing should count. `head: true` makes
    // this a cheap count-only query.
    supabase
      .from("calls")
      .select("id", { count: "exact", head: true })
      .in("status", ACTIVE_STATUSES as unknown as string[]),
  ]);

  if (error || !data) {
    return {
      callsToday: 0,
      connectRateToday: 0,
      goalMetToday: 0,
      inProgressNow: inProgressCount ?? 0,
    };
  }

  let connected = 0;
  let goalMet = 0;
  for (const row of data) {
    if (row.outcome && CONNECTED_OUTCOMES.has(row.outcome)) connected++;
    if (row.goal_met) goalMet++;
  }
  const callsToday = data.length;
  const connectRateToday = callsToday > 0 ? connected / callsToday : 0;

  return {
    callsToday,
    connectRateToday,
    goalMetToday: goalMet,
    inProgressNow: inProgressCount ?? 0,
  };
}
