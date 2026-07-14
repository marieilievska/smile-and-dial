import type { SupabaseClient } from "@supabase/supabase-js";

import { pickBreakdown } from "@/lib/analytics/costs";
import {
  etDayString,
  etMidnightUtcIso,
  startOfTodayEtIso,
} from "@/lib/time/eastern";

const PAGE = 1000;

/** Page past PostgREST's hard 1,000-row cap. An un-paginated `.select()` over a
 *  busy month silently returns only the first 1,000 calls, so every spend
 *  rollup built by summing rows in JS undercounts (and the month-end projection
 *  built on that total reads far too low). `makeQuery` must return a fresh
 *  range-bounded query per page. Mirrors `fetchCostRows` in lib/analytics/costs. */
async function fetchAllRows<T>(
  makeQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data } = await makeQuery(offset, offset + PAGE - 1);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE) break;
    if (offset > 500_000) break; // safety backstop
  }
  return rows;
}

export type CostsHeadlineStats = {
  /** Spend across all calls today (workspace-wide, unaffected by
   *  page slicers) — used for the budget-pace tile. */
  todaySpend: number;
  /** Month-to-date spend across the workspace. */
  mtdSpend: number;
  /** Straight-line projection of where month-end spend lands if the
   *  current daily pace holds: mtd / daysElapsed × daysInMonth. */
  projectedMonthSpend: number;
};

/** Pulls today + month-to-date spend (and a month-end projection). Powers the
 *  budget-pace tile, which stays fixed when the user changes the page-level
 *  date filter so it always answers "am I on track this month?". Both source
 *  queries page past the 1,000-row cap so the month total — and the projection
 *  built on it — stay correct once the month exceeds 1,000 calls. */
export async function fetchCostsHeadlineStats(
  supabase: SupabaseClient,
): Promise<CostsHeadlineStats> {
  const now = new Date();
  // Eastern calendar-day / month boundaries (the app-wide convention) so the
  // "today" and month-to-date spend match the rest of the app rather than the
  // server's UTC midnight (~7-8pm ET).
  const todayEt = etDayString(now);
  const [cy, cm] = todayEt.split("-").map(Number);
  const startOfMonthIso = etMidnightUtcIso(
    `${cy}-${String(cm).padStart(2, "0")}-01`,
  );

  const [data, lookupRows] = await Promise.all([
    fetchAllRows<{ cost_breakdown: unknown; created_at: string }>((from, to) =>
      supabase
        .from("calls")
        .select("cost_breakdown, created_at")
        .gte("created_at", startOfMonthIso)
        .order("created_at", { ascending: false })
        .range(from, to),
    ),
    // Import-lookup charges this month (billed outside calls).
    fetchAllRows<{ cost: number; created_at: string }>((from, to) =>
      supabase
        .from("lookup_charges")
        .select("cost, created_at")
        .gte("created_at", startOfMonthIso)
        .order("created_at", { ascending: false })
        .range(from, to),
    ),
  ]);

  let todaySpend = 0;
  let mtdSpend = 0;
  const todayIso = startOfTodayEtIso(now);
  for (const row of data) {
    const breakdown = pickBreakdown(row.cost_breakdown);
    mtdSpend += breakdown.total;
    if (row.created_at >= todayIso) {
      todaySpend += breakdown.total;
    }
  }
  for (const row of lookupRows) {
    const cost = Number(row.cost) || 0;
    mtdSpend += cost;
    if (row.created_at >= todayIso) todaySpend += cost;
  }

  // Linear month-end projection. dayOfMonth counts today as elapsed so
  // the first of the month doesn't divide by zero.
  const dayOfMonth = Number(todayEt.split("-")[2]);
  const daysInMonth = new Date(Date.UTC(cy, cm, 0)).getUTCDate();
  const projectedMonthSpend =
    dayOfMonth > 0 ? (mtdSpend / dayOfMonth) * daysInMonth : mtdSpend;

  return { todaySpend, mtdSpend, projectedMonthSpend };
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
  // Eastern month/day boundaries (app-wide convention), matching the headline.
  const now = new Date();
  const todayEt = etDayString(now);
  const [cy, cm] = todayEt.split("-").map(Number);
  const startOfMonthIso = etMidnightUtcIso(
    `${cy}-${String(cm).padStart(2, "0")}-01`,
  );
  const [{ data: campaigns }, calls] = await Promise.all([
    supabase
      .from("campaigns")
      .select("id, name, status, daily_spend_cap, monthly_spend_cap"),
    // Page past the 1,000-row cap so a busy month doesn't undercount each
    // campaign's month spend (and its progress against the monthly cap).
    fetchAllRows<{
      campaign_id: string;
      cost_breakdown: unknown;
      created_at: string;
    }>((from, to) =>
      supabase
        .from("calls")
        .select("campaign_id, cost_breakdown, created_at")
        .gte("created_at", startOfMonthIso)
        .order("created_at", { ascending: false })
        .range(from, to),
    ),
  ]);

  const dayIso = startOfTodayEtIso(now);

  const spendDay = new Map<string, number>();
  const spendMonth = new Map<string, number>();
  for (const r of calls) {
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
