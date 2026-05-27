import type { SupabaseClient } from "@supabase/supabase-js";

/** At-a-glance numbers for the /campaigns header strip:
 *   - active        — count(status = active)
 *   - paused        — count(status = paused)
 *   - callsToday    — total calls placed today across all campaigns
 *   - spendToday    — sum of cost_breakdown.total across today's calls
 *
 *  All four respect RLS, so members only see their own campaigns;
 *  admins see everything. */
export type CampaignStats = {
  active: number;
  paused: number;
  callsToday: number;
  spendToday: number;
};

export async function fetchCampaignStats(
  supabase: SupabaseClient,
): Promise<CampaignStats> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const isoStart = startOfToday.toISOString();

  const [active, paused, callsToday] = await Promise.all([
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
      .select("cost_breakdown", { count: "exact" })
      .gte("created_at", isoStart),
  ]);

  // Sum spend across today's calls. The cost_breakdown JSON looks like
  // `{ total: 0.07, ... }`; we just sum the .total numbers.
  let spendToday = 0;
  for (const row of callsToday.data ?? []) {
    const total = (row as { cost_breakdown?: { total?: number } | null })
      ?.cost_breakdown?.total;
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
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const { data } = await supabase
    .from("calls")
    .select("campaign_id, cost_breakdown")
    .gte("created_at", startOfToday.toISOString());

  const out = new Map<string, CampaignTodaySpend>();
  for (const row of (data ?? []) as {
    campaign_id: string | null;
    cost_breakdown: { total?: number } | null;
  }[]) {
    if (!row.campaign_id) continue;
    const prev = out.get(row.campaign_id) ?? { callsToday: 0, spendToday: 0 };
    prev.callsToday += 1;
    const t = row.cost_breakdown?.total;
    if (typeof t === "number") prev.spendToday += t;
    out.set(row.campaign_id, prev);
  }
  return out;
}
