import type { SupabaseClient } from "@supabase/supabase-js";

/** Cost rollups derived from the same `calls.cost_breakdown` JSON Phase 5
 *  populated. Six views, all backed by one fetch. */

export type CostsRow = {
  id: string;
  lead_id: string;
  campaign_id: string;
  goal_met: boolean;
  duration_seconds: number | null;
  cost_breakdown: unknown;
  started_at: string | null;
  created_at: string;
};

export type Slicers = {
  campaignId?: string;
  ownerId?: string;
  listId?: string;
  from: string;
  to: string;
};

export type Breakdown = {
  twilio: number;
  elevenlabs: number;
  openai: number;
  lookup: number;
  total: number;
};

const ZERO: Breakdown = {
  twilio: 0,
  elevenlabs: 0,
  openai: 0,
  lookup: 0,
  total: 0,
};

export function pickBreakdown(value: unknown): Breakdown {
  if (!value || typeof value !== "object") return { ...ZERO };
  const v = value as Record<string, unknown>;
  const n = (k: string) =>
    typeof v[k] === "number" && Number.isFinite(v[k] as number)
      ? (v[k] as number)
      : 0;
  return {
    twilio: n("twilio"),
    elevenlabs: n("elevenlabs"),
    openai: n("openai"),
    lookup: n("lookup"),
    total: n("total"),
  };
}

function addInto(acc: Breakdown, b: Breakdown) {
  acc.twilio += b.twilio;
  acc.elevenlabs += b.elevenlabs;
  acc.openai += b.openai;
  acc.lookup += b.lookup;
  acc.total += b.total;
}

function startOfDay(day: string): string {
  return `${day}T00:00:00.000Z`;
}
function endOfDay(day: string): string {
  return `${day}T23:59:59.999Z`;
}

export async function fetchCostRows(
  supabase: SupabaseClient,
  slicers: Slicers,
): Promise<CostsRow[]> {
  let query = supabase
    .from("calls")
    .select(
      "id, lead_id, campaign_id, goal_met, duration_seconds, cost_breakdown, started_at, created_at",
    )
    .gte("created_at", startOfDay(slicers.from))
    .lte("created_at", endOfDay(slicers.to))
    .order("created_at", { ascending: false });
  if (slicers.campaignId) query = query.eq("campaign_id", slicers.campaignId);

  const { data } = await query;
  let rows = (data ?? []) as unknown as CostsRow[];

  if (slicers.ownerId || slicers.listId) {
    const leadIds = Array.from(new Set(rows.map((r) => r.lead_id)));
    if (leadIds.length === 0) return [];
    let leadQuery = supabase.from("leads").select("id").in("id", leadIds);
    if (slicers.listId) leadQuery = leadQuery.eq("list_id", slicers.listId);
    if (slicers.ownerId) leadQuery = leadQuery.eq("owner_id", slicers.ownerId);
    const { data: leads } = await leadQuery;
    const ok = new Set((leads ?? []).map((l) => l.id));
    rows = rows.filter((r) => ok.has(r.lead_id));
  }
  return rows;
}

export type PerCampaign = {
  campaignId: string;
  calls: number;
  goalMet: number;
  spend: Breakdown;
  avgPerCall: number;
  costPerGoalMet: number;
};

export function rollupByCampaign(rows: CostsRow[]): PerCampaign[] {
  const acc = new Map<
    string,
    { calls: number; goalMet: number; spend: Breakdown }
  >();
  for (const r of rows) {
    const cur = acc.get(r.campaign_id) ?? {
      calls: 0,
      goalMet: 0,
      spend: { ...ZERO },
    };
    cur.calls += 1;
    if (r.goal_met) cur.goalMet += 1;
    addInto(cur.spend, pickBreakdown(r.cost_breakdown));
    acc.set(r.campaign_id, cur);
  }
  return [...acc.entries()]
    .map(([campaignId, v]) => ({
      campaignId,
      calls: v.calls,
      goalMet: v.goalMet,
      spend: v.spend,
      avgPerCall: v.calls === 0 ? 0 : v.spend.total / v.calls,
      costPerGoalMet: v.goalMet === 0 ? 0 : v.spend.total / v.goalMet,
    }))
    .sort((a, b) => b.spend.total - a.spend.total);
}

export type PerGoal = {
  campaignId: string;
  goalMet: number;
  spend: number;
  costPerGoalMet: number;
};

export function rollupByGoalMet(rows: CostsRow[]): PerGoal[] {
  const acc = new Map<string, { goalMet: number; spend: number }>();
  for (const r of rows) {
    const cur = acc.get(r.campaign_id) ?? { goalMet: 0, spend: 0 };
    if (r.goal_met) cur.goalMet += 1;
    cur.spend += pickBreakdown(r.cost_breakdown).total;
    acc.set(r.campaign_id, cur);
  }
  return [...acc.entries()]
    .map(([campaignId, v]) => ({
      campaignId,
      goalMet: v.goalMet,
      spend: v.spend,
      costPerGoalMet: v.goalMet === 0 ? 0 : v.spend / v.goalMet,
    }))
    .filter((r) => r.goalMet > 0)
    .sort((a, b) => a.costPerGoalMet - b.costPerGoalMet);
}

export type PerUser = {
  ownerId: string;
  calls: number;
  spend: number;
};

/** Per-user requires a lead lookup since calls don't carry owner_id. */
export async function rollupByUser(
  supabase: SupabaseClient,
  rows: CostsRow[],
): Promise<PerUser[]> {
  if (rows.length === 0) return [];
  const leadIds = Array.from(new Set(rows.map((r) => r.lead_id)));
  const { data: leads } = await supabase
    .from("leads")
    .select("id, owner_id")
    .in("id", leadIds);
  const owner = new Map<string, string>();
  for (const l of leads ?? []) owner.set(l.id, l.owner_id);
  const acc = new Map<string, { calls: number; spend: number }>();
  for (const r of rows) {
    const oid = owner.get(r.lead_id);
    if (!oid) continue;
    const cur = acc.get(oid) ?? { calls: 0, spend: 0 };
    cur.calls += 1;
    cur.spend += pickBreakdown(r.cost_breakdown).total;
    acc.set(oid, cur);
  }
  return [...acc.entries()]
    .map(([ownerId, v]) => ({
      ownerId,
      calls: v.calls,
      spend: v.spend,
    }))
    .sort((a, b) => b.spend - a.spend);
}

export type PerTime = { day: string; spend: number; calls: number };

export function rollupByTime(rows: CostsRow[], slicers: Slicers): PerTime[] {
  const buckets = new Map<string, { spend: number; calls: number }>();
  const start = new Date(`${slicers.from}T00:00:00Z`);
  const end = new Date(`${slicers.to}T00:00:00Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    buckets.set(d.toISOString().slice(0, 10), { spend: 0, calls: 0 });
  }
  for (const r of rows) {
    const day = r.created_at.slice(0, 10);
    const cur = buckets.get(day) ?? { spend: 0, calls: 0 };
    cur.spend += pickBreakdown(r.cost_breakdown).total;
    cur.calls += 1;
    buckets.set(day, cur);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, v]) => ({ day, spend: v.spend, calls: v.calls }));
}

export function rollupByVendor(rows: CostsRow[]): Breakdown {
  const acc: Breakdown = { ...ZERO };
  for (const r of rows) addInto(acc, pickBreakdown(r.cost_breakdown));
  return acc;
}

export function resolveDatePreset(
  preset: string,
  custom: { from?: string; to?: string },
): { from: string; to: string } {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const daysAgo = (n: number) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  switch (preset) {
    case "today":
      return { from: todayStr, to: todayStr };
    case "last7":
      return { from: daysAgo(6), to: todayStr };
    case "last30":
      return { from: daysAgo(29), to: todayStr };
    case "this_month": {
      const first = `${todayStr.slice(0, 7)}-01`;
      return { from: first, to: todayStr };
    }
    case "last_month": {
      const firstThis = new Date(`${todayStr.slice(0, 7)}-01T00:00:00Z`);
      const lastPrev = new Date(firstThis);
      lastPrev.setUTCDate(lastPrev.getUTCDate() - 1);
      const firstPrev = new Date(lastPrev);
      firstPrev.setUTCDate(1);
      return {
        from: firstPrev.toISOString().slice(0, 10),
        to: lastPrev.toISOString().slice(0, 10),
      };
    }
    case "custom":
      return {
        from: custom.from ?? daysAgo(29),
        to: custom.to ?? todayStr,
      };
    default:
      return { from: daysAgo(29), to: todayStr };
  }
}
