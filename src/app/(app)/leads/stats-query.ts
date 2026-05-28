import type { createClient } from "@/lib/supabase/server";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export type LeadStats = {
  readyToCall: number;
  callbacksDue: number;
  saleThisWeek: number;
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

  // Start of "this week" — Monday 00:00. Most operators think weeks
  // start on Monday; if you live in a Sunday-first culture, swap below.
  const startOfWeek = new Date(now);
  const dow = (now.getDay() + 6) % 7; // 0 = Monday, 6 = Sunday
  startOfWeek.setDate(now.getDate() - dow);
  startOfWeek.setHours(0, 0, 0, 0);

  const [readyResult, callbackResult, saleResult] = await Promise.all([
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
    supabase
      .from("leads")
      .select("*", { count: "exact", head: true })
      .is("deleted_at", null)
      .in("status", ["sale", "goal_met", "attended", "closed"])
      .gte("updated_at", startOfWeek.toISOString()),
  ]);

  return {
    readyToCall: readyResult.count ?? 0,
    callbacksDue: callbackResult.count ?? 0,
    saleThisWeek: saleResult.count ?? 0,
  };
}
