import type { SupabaseClient } from "@supabase/supabase-js";

import { pickBreakdown } from "@/lib/analytics/costs";

export type CostsHeadlineStats = {
  /** Spend across all calls today (workspace-wide, unaffected by
   *  page slicers) — used for the "Today / MTD" context chip. */
  todaySpend: number;
  /** Month-to-date spend across the workspace. */
  mtdSpend: number;
};

/** Pulls today + month-to-date spend in a single query. Used to add
 *  a quick orientation chip in the page header that doesn't shift
 *  when the user changes the page-level date filter. */
export async function fetchCostsHeadlineStats(
  supabase: SupabaseClient,
): Promise<CostsHeadlineStats> {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const startOfMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  );

  const { data } = await supabase
    .from("calls")
    .select("cost_breakdown, created_at")
    .gte("created_at", startOfMonth.toISOString());

  let todaySpend = 0;
  let mtdSpend = 0;
  const todayIso = startOfDay.toISOString();
  for (const row of data ?? []) {
    const breakdown = pickBreakdown(
      (row as { cost_breakdown: unknown }).cost_breakdown,
    );
    mtdSpend += breakdown.total;
    if ((row as { created_at: string }).created_at >= todayIso) {
      todaySpend += breakdown.total;
    }
  }
  return { todaySpend, mtdSpend };
}

export type CampaignCap = {
  campaignId: string;
  name: string;
  status: string;
  dailySpendCap: number | null;
  monthlySpendCap: number | null;
  daySpend: number;
  monthSpend: number;
};

/** Pulls each campaign's spend caps and current day / month spend
 *  so the Per-campaign view can render a progress bar against the
 *  cap. Campaigns without a cap return `null` for that field. */
export async function fetchCampaignCaps(
  supabase: SupabaseClient,
): Promise<Map<string, CampaignCap>> {
  const out = new Map<string, CampaignCap>();
  const [{ data: campaigns }, { data: calls }] = await Promise.all([
    supabase
      .from("campaigns")
      .select("id, name, status, daily_spend_cap, monthly_spend_cap"),
    (async () => {
      const startOfMonth = new Date();
      startOfMonth.setUTCDate(1);
      startOfMonth.setUTCHours(0, 0, 0, 0);
      return supabase
        .from("calls")
        .select("campaign_id, cost_breakdown, created_at")
        .gte("created_at", startOfMonth.toISOString());
    })(),
  ]);

  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayIso = dayStart.toISOString();

  const spendDay = new Map<string, number>();
  const spendMonth = new Map<string, number>();
  for (const row of calls ?? []) {
    const r = row as {
      campaign_id: string;
      cost_breakdown: unknown;
      created_at: string;
    };
    const total = pickBreakdown(r.cost_breakdown).total;
    spendMonth.set(r.campaign_id, (spendMonth.get(r.campaign_id) ?? 0) + total);
    if (r.created_at >= dayIso) {
      spendDay.set(r.campaign_id, (spendDay.get(r.campaign_id) ?? 0) + total);
    }
  }

  for (const c of campaigns ?? []) {
    const row = c as {
      id: string;
      name: string;
      status: string;
      daily_spend_cap: number | null;
      monthly_spend_cap: number | null;
    };
    out.set(row.id, {
      campaignId: row.id,
      name: row.name,
      status: row.status,
      dailySpendCap: row.daily_spend_cap,
      monthlySpendCap: row.monthly_spend_cap,
      daySpend: spendDay.get(row.id) ?? 0,
      monthSpend: spendMonth.get(row.id) ?? 0,
    });
  }
  return out;
}
