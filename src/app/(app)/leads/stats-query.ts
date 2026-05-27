import type { createClient } from "@/lib/supabase/server";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

export type LeadStats = {
  readyToCall: number;
  callbacksDue: number;
  saleThisWeek: number;
  addedToday: number;
};

/** Compute the 4-stat strip shown under the Leads page header.
 *  Each stat is a count-only query (head=true, count=exact). They run
 *  in parallel because they're independent. */
export async function fetchLeadStats(
  supabase: SupabaseServerClient,
): Promise<LeadStats> {
  const now = new Date();

  // Today, in the server's local time. Good enough for a glanceable
  // stat — exact timezone math sits in lib/timezone for real schedules.
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  // Start of "this week" — Monday 00:00. Most operators think weeks
  // start on Monday; if you live in a Sunday-first culture, swap below.
  const startOfWeek = new Date(now);
  const dow = (now.getDay() + 6) % 7; // 0 = Monday, 6 = Sunday
  startOfWeek.setDate(now.getDate() - dow);
  startOfWeek.setHours(0, 0, 0, 0);

  const [readyResult, callbackResult, saleResult, addedResult] =
    await Promise.all([
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
      supabase
        .from("leads")
        .select("*", { count: "exact", head: true })
        .is("deleted_at", null)
        .gte("created_at", startOfToday.toISOString()),
    ]);

  return {
    readyToCall: readyResult.count ?? 0,
    callbacksDue: callbackResult.count ?? 0,
    saleThisWeek: saleResult.count ?? 0,
    addedToday: addedResult.count ?? 0,
  };
}
