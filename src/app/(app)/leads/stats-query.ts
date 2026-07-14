import type { createClient } from "@/lib/supabase/server";

import {
  etDateDaysAgo,
  etDayString,
  etMidnightUtcIso,
} from "@/lib/time/eastern";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export type LeadStats = {
  readyToCall: number;
  callbacksDue: number;
  goalsMetThisWeek: number;
  /** Monday 00:00 of the current week as a YYYY-MM-DD date string. The
   *  "Goals met this week" tile links to the Calls list scoped from this
   *  date, so the destination shows the same window the count came from. */
  weekStartDate: string;
};

/** Compute the 3-stat strip shown under the Leads page header.
 *  Each stat is a count-only query (head=true, count=exact). They run
 *  in parallel because they're independent.
 *
 *  Round 30 — dropped the "added today" count when the matching tile
 *  came out of the strip (D3, 4→3). The query was an extra round trip
 *  for a non-actionable number. */
export async function fetchLeadStats(
  supabase: SupabaseServerClient,
): Promise<LeadStats> {
  const now = new Date();

  // Start of "this week" — Monday 00:00 Eastern (the app-wide day convention),
  // so this tile and its Calls-list destination agree instead of drifting to
  // the server's UTC midnight. Day-of-week comes from the ET calendar date;
  // back up to Monday and take that ET date's UTC midnight.
  const todayEt = etDayString(now); // YYYY-MM-DD
  const [ty, tm, td] = todayEt.split("-").map(Number);
  const dow = (new Date(Date.UTC(ty, tm - 1, td)).getUTCDay() + 6) % 7; // 0=Mon
  const weekStartDate = etDateDaysAgo(dow, now); // Monday's ET date (YYYY-MM-DD)
  const startOfWeekIso = etMidnightUtcIso(weekStartDate);

  const [readyResult, callbackResult, goalsMetResult] = await Promise.all([
    supabase
      .from("leads")
      .select("*", { count: "exact", head: true })
      .is("deleted_at", null)
      .eq("status", "ready_to_call"),
    supabase
      .from("leads")
      .select("*", { count: "exact", head: true })
      .is("deleted_at", null)
      .eq("status", "callback"),
    // Goals met this week = goal-met CALLS that ended this week. We count
    // calls (not leads) so the tile matches its destination exactly: the
    // Calls list filtered to goal_met=yes for the same window. `ended_at`
    // never changes after a call finishes, so — unlike the old query, which
    // keyed off the lead's updated_at — editing a long-ago won lead no
    // longer re-counts it into this week.
    supabase
      .from("calls")
      .select("*", { count: "exact", head: true })
      .eq("goal_met", true)
      .gte("ended_at", startOfWeekIso),
  ]);

  return {
    readyToCall: readyResult.count ?? 0,
    callbacksDue: callbackResult.count ?? 0,
    goalsMetThisWeek: goalsMetResult.count ?? 0,
    weekStartDate,
  };
}
