import { CONNECTED_OUTCOMES } from "@/lib/calls/outcomes";
import type { createClient } from "@/lib/supabase/server";
import { startOfTodayEtIso } from "@/lib/time/eastern";

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

const PAGE = 1000;

/** Page past PostgREST's 1,000-row response cap. A bare `.limit(5000)` is
 *  silently clamped to 1,000 rows by the server, so on any day with >1,000
 *  calls the strip froze at exactly 1,000 and the connect/goal rates were
 *  computed from an arbitrary 1,000-row slice. Mirrors the pagination the
 *  Today, Campaigns, and Analytics pages already use. */
async function fetchTodayStatRows(
  supabase: SupabaseServerClient,
  isoStart: string,
): Promise<{ outcome: string | null; goal_met: boolean | null }[]> {
  const rows: { outcome: string | null; goal_met: boolean | null }[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data } = await supabase
      .from("calls")
      .select("outcome, goal_met")
      .gte("started_at", isoStart)
      .order("started_at", { ascending: true })
      .range(offset, offset + PAGE - 1);
    const batch = (data ?? []) as {
      outcome: string | null;
      goal_met: boolean | null;
    }[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
    if (offset > 500_000) break; // safety backstop
  }
  return rows;
}

/** Compute the 3-stat strip shown under the /calls page header.
 *  Read-only — every stat is "today so far" against the server clock.
 *  Today's calls are paginated (see fetchTodayStatRows), then reduced in JS.
 *
 *  Round 30 — dropped the spend column (D3, 4→3). The /costs page is
 *  the proper home for financial signals; mirroring it here was
 *  duplication. */
export async function fetchCallStats(
  supabase: SupabaseServerClient,
): Promise<CallStats> {
  // Eastern day start — "today" matches the Today/Costs pages and the ET
  // calendar, so a 9pm-ET call still counts as today (not tomorrow).
  const startOfToday = startOfTodayEtIso();

  const [rows, { count: inProgressCount }] = await Promise.all([
    fetchTodayStatRows(supabase, startOfToday),
    // Live count is status-driven, not date-bound: a call queued
    // yesterday that's still ringing should count. `head: true` makes
    // this a cheap count-only query.
    supabase
      .from("calls")
      .select("id", { count: "exact", head: true })
      .in("status", ACTIVE_STATUSES as unknown as string[]),
  ]);

  let connected = 0;
  let goalMet = 0;
  for (const row of rows) {
    if (row.outcome && CONNECTED_OUTCOMES.has(row.outcome)) connected++;
    if (row.goal_met) goalMet++;
  }
  const callsToday = rows.length;
  const connectRateToday = callsToday > 0 ? connected / callsToday : 0;

  return {
    callsToday,
    connectRateToday,
    goalMetToday: goalMet,
    inProgressNow: inProgressCount ?? 0,
  };
}
