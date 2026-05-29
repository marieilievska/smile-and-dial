import type { SupabaseClient } from "@supabase/supabase-js";

/** Number of days the header sparkline covers. */
const TREND_DAYS = 14;

export type DncStats = {
  total: number;
  addedThisWeek: number;
  topReason: { key: string; count: number } | null;
  /** People who explicitly asked to stop being called (reason
   *  `dnc_requested`) — the compliance signal worth watching. */
  callerRequested: number;
  /** Additions per day over the last {@link TREND_DAYS} days, oldest
   *  first, pre-seeded with zeros so the sparkline never has gaps. */
  addedDaily: number[];
};

/** Pulls the stat-strip numbers + a 14-day additions trend for the DNC
 *  page. Aggregations are tiny — every DNC row is just
 *  (phone, reason, added_at) — so doing the rollups in JS is fine.
 *  Keeps the query layer dumb and the page layer readable. */
export async function fetchDncStats(
  supabase: SupabaseClient,
): Promise<DncStats> {
  const weekStart = new Date();
  weekStart.setUTCDate(weekStart.getUTCDate() - 7);
  weekStart.setUTCHours(0, 0, 0, 0);

  // Start of the sparkline window (TREND_DAYS buckets, today inclusive).
  const trendStart = new Date();
  trendStart.setUTCHours(0, 0, 0, 0);
  trendStart.setUTCDate(trendStart.getUTCDate() - (TREND_DAYS - 1));

  const [
    { count: total },
    { count: addedThisWeek },
    { data: byReason },
    { data: recent },
  ] = await Promise.all([
    supabase.from("dnc_entries").select("id", { count: "exact", head: true }),
    supabase
      .from("dnc_entries")
      .select("id", { count: "exact", head: true })
      .gte("added_at", weekStart.toISOString()),
    supabase.from("dnc_entries").select("reason"),
    supabase
      .from("dnc_entries")
      .select("added_at")
      .gte("added_at", trendStart.toISOString()),
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

  // Bucket recent additions into one slot per day, pre-seeded with zeros.
  const dayKeys: string[] = [];
  for (let i = 0; i < TREND_DAYS; i++) {
    const d = new Date(trendStart);
    d.setUTCDate(d.getUTCDate() + i);
    dayKeys.push(d.toISOString().slice(0, 10));
  }
  const dayIndex = new Map(dayKeys.map((k, i) => [k, i] as const));
  const addedDaily = new Array<number>(TREND_DAYS).fill(0);
  for (const row of recent ?? []) {
    const day = String((row as { added_at: string }).added_at).slice(0, 10);
    const idx = dayIndex.get(day);
    if (idx !== undefined) addedDaily[idx] += 1;
  }

  return {
    total: total ?? 0,
    addedThisWeek: addedThisWeek ?? 0,
    topReason,
    callerRequested: reasonCounts.get("dnc_requested") ?? 0,
    addedDaily,
  };
}
