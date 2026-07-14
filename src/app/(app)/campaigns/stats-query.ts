import type { SupabaseClient } from "@supabase/supabase-js";

import { startOfTodayEtIso } from "@/lib/time/eastern";

/** At-a-glance numbers for the /campaigns header strip:
 *   - active        — count(status = active)
 *   - paused        — count(status = paused)
 *   - callsToday    — total calls placed today across all campaigns
 *   - spendToday    — sum of cost_breakdown.total across today's calls
 *
 *  "Today" is the Eastern-time calendar day, matching every other dashboard.
 *  All four respect RLS, so members only see their own campaigns;
 *  admins see everything. */
export type CampaignStats = {
  active: number;
  paused: number;
  callsToday: number;
  spendToday: number;
};

const PAGE = 1000;

/** Page through today's calls past PostgREST's 1,000-row response cap, so the
 *  spend sum doesn't silently undercount once a day exceeds 1,000 calls (the
 *  scale this product runs at). Callers pass only the columns they need. */
async function fetchTodayCallRows<T>(
  supabase: SupabaseClient,
  columns: string,
  isoStart: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data } = await supabase
      .from("calls")
      .select(columns)
      .gte("created_at", isoStart)
      .order("created_at", { ascending: true })
      .range(offset, offset + PAGE - 1);
    const batch = (data ?? []) as unknown as T[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
    if (offset > 500_000) break; // safety backstop
  }
  return rows;
}

export async function fetchCampaignStats(
  supabase: SupabaseClient,
): Promise<CampaignStats> {
  const isoStart = startOfTodayEtIso();

  const [active, paused, callsToday, spendRows] = await Promise.all([
    supabase
      .from("campaigns")
      .select("id", { count: "exact", head: true })
      .eq("status", "active"),
    supabase
      .from("campaigns")
      .select("id", { count: "exact", head: true })
      .eq("status", "paused"),
    supabase
      .from("calls")
      .select("id", { count: "exact", head: true })
      .gte("created_at", isoStart),
    fetchTodayCallRows<{ cost_breakdown: { total?: number } | null }>(
      supabase,
      "cost_breakdown",
      isoStart,
    ),
  ]);

  // Sum spend across today's calls. The cost_breakdown JSON looks like
  // `{ total: 0.07, ... }`; we just sum the .total numbers.
  let spendToday = 0;
  for (const row of spendRows) {
    const total = row.cost_breakdown?.total;
    if (typeof total === "number") spendToday += total;
  }

  return {
    active: active.count ?? 0,
    paused: paused.count ?? 0,
    callsToday: callsToday.count ?? 0,
    spendToday,
  };
}

/** Per-campaign operational stats for the table — calls placed today
 *  and spend so far today. Returned as a Map keyed by campaign_id
 *  so the page can fold them into the row without per-row queries. */
export type CampaignTodaySpend = {
  callsToday: number;
  spendToday: number;
};

export async function fetchPerCampaignSpend(
  supabase: SupabaseClient,
): Promise<Map<string, CampaignTodaySpend>> {
  const rows = await fetchTodayCallRows<{
    campaign_id: string | null;
    cost_breakdown: { total?: number } | null;
  }>(supabase, "campaign_id, cost_breakdown", startOfTodayEtIso());

  const out = new Map<string, CampaignTodaySpend>();
  for (const row of rows) {
    if (!row.campaign_id) continue;
    const prev = out.get(row.campaign_id) ?? { callsToday: 0, spendToday: 0 };
    prev.callsToday += 1;
    const t = row.cost_breakdown?.total;
    if (typeof t === "number") prev.spendToday += t;
    out.set(row.campaign_id, prev);
  }
  return out;
}
