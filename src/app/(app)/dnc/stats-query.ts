import type { SupabaseClient } from "@supabase/supabase-js";

export type DncStats = {
  total: number;
  addedThisWeek: number;
  topReason: { key: string; count: number } | null;
  importedShare: number; // 0..1
};

/** Pulls the 4 stat-strip numbers for the DNC page in a single
 *  round-trip pattern: one query for the recent slice (used for
 *  "added this week"), one full-count query, and a per-reason
 *  rollup. Aggregations are tiny — every DNC row is just
 *  (phone, reason, added_at) — so doing the rollup in JS is fine.
 *  Keeps the query layer dumb and the page layer readable. */
export async function fetchDncStats(
  supabase: SupabaseClient,
): Promise<DncStats> {
  const weekStart = new Date();
  weekStart.setUTCDate(weekStart.getUTCDate() - 7);
  weekStart.setUTCHours(0, 0, 0, 0);

  const [{ count: total }, { count: addedThisWeek }, { data: byReason }] =
    await Promise.all([
      supabase.from("dnc_entries").select("id", { count: "exact", head: true }),
      supabase
        .from("dnc_entries")
        .select("id", { count: "exact", head: true })
        .gte("added_at", weekStart.toISOString()),
      supabase.from("dnc_entries").select("reason"),
    ]);

  const reasonCounts = new Map<string, number>();
  for (const row of byReason ?? []) {
    const key = (row as { reason: string }).reason;
    reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
  }
  let topReason: { key: string; count: number } | null = null;
  for (const [key, count] of reasonCounts) {
    if (!topReason || count > topReason.count) {
      topReason = { key, count };
    }
  }

  const importedCount = reasonCounts.get("imported") ?? 0;
  const safeTotal = total ?? 0;
  const importedShare = safeTotal === 0 ? 0 : importedCount / safeTotal;

  return {
    total: safeTotal,
    addedThisWeek: addedThisWeek ?? 0,
    topReason,
    importedShare,
  };
}
