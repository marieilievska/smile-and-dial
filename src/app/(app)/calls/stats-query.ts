import type { createClient } from "@/lib/supabase/server";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export type CallStats = {
  callsToday: number;
  connectRateToday: number;
  goalMetToday: number;
};

/** Outcomes that count as a "connected" call for the connect-rate stat.
 *  Mirrors the rationale used on the Today page's pace strip. */
const CONNECTED_OUTCOMES = new Set([
  "goal_met",
  "transferred_to_human",
  "not_interested",
  "callback",
  "ai_receptionist",
  "language_barrier",
  "gatekeeper",
]);

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
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from("calls")
    .select("outcome, goal_met")
    .gte("started_at", startOfToday.toISOString())
    .limit(5000);

  if (error || !data) {
    return {
      callsToday: 0,
      connectRateToday: 0,
      goalMetToday: 0,
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
  };
}
