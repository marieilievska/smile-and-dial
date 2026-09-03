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

type TodayStatRow = {
  outcome: string | null;
  goal_met: boolean | null;
  lead_id: string | null;
};

/** Page past PostgREST's 1,000-row response cap. A bare `.limit(5000)` is
 *  silently clamped to 1,000 rows by the server, so on any day with >1,000
 *  calls the strip froze at exactly 1,000 and the connect/goal rates were
 *  computed from an arbitrary 1,000-row slice. Mirrors the pagination the
 *  Today, Campaigns, and Analytics pages already use. */
async function fetchTodayStatRows(
  supabase: SupabaseServerClient,
  isoStart: string,
): Promise<TodayStatRow[]> {
  const rows: TodayStatRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data } = await supabase
      .from("calls")
      .select("outcome, goal_met, lead_id")
      .gte("created_at", isoStart)
      .order("created_at", { ascending: true })
      .range(offset, offset + PAGE - 1);
    const batch = (data ?? []) as TodayStatRow[];
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
  // Eastern day start on `created_at` — the SAME window and column as the
  // Today, Campaigns, Costs and Analytics "calls today" numbers, so every page
  // shows one figure. (This used to key on started_at, which drops the rare
  // row whose dial never left the queue.)
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
  let aiError = 0;
  // Goals are per BUSINESS (distinct lead), the app-wide rule — a lead booked
  // twice in a day is one goal, matching the Today tile and Reporting.
  const goalLeads = new Set<string>();
  for (const row of rows) {
    if (row.outcome && CONNECTED_OUTCOMES.has(row.outcome)) connected++;
    if (row.outcome === "ai_error") aiError++;
    if (row.goal_met) goalLeads.add(row.lead_id ?? "");
  }
  const goalMet = goalLeads.size;
  const callsToday = rows.length;
  // ai_error = OUR quota/platform failure — out of the connect-rate denominator
  // so an EL credit outage doesn't distort the rate.
  const connectRateToday =
    callsToday - aiError > 0 ? connected / (callsToday - aiError) : 0;

  return {
    callsToday,
    connectRateToday,
    goalMetToday: goalMet,
    inProgressNow: inProgressCount ?? 0,
  };
}
