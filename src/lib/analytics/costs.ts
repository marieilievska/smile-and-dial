import type { SupabaseClient } from "@supabase/supabase-js";

import { ID_CHUNK, chunk } from "@/lib/leads/chunk";
import {
  addBreakdownInto,
  zeroBreakdown,
  type Breakdown,
} from "@/lib/costs/breakdown";
import { fetchAllRows } from "@/lib/supabase/fetch-all-rows";
import {
  endOfEtDayUtcIso,
  etDateDaysAgo,
  etDayRangeUtc,
  etDayString,
} from "@/lib/time/eastern";

/** Cost rollups derived from the same `calls.cost_breakdown` JSON Phase 5
 *  populated. Six views, all backed by one fetch. The breakdown parsing itself
 *  lives in lib/costs/breakdown (pure, client-safe) — re-exported here so the
 *  older import path keeps working. */

export { pickBreakdown, type Breakdown } from "@/lib/costs/breakdown";

export type CostsRow = {
  id: string;
  lead_id: string;
  campaign_id: string | null;
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

/** Rollup rows for calls whose campaign was deleted carry a NULL campaign_id
 *  (deleteCampaign detaches calls via `on delete set null`). They are keyed
 *  under this sentinel in the per-campaign views so the spend still shows. */
export const NO_CAMPAIGN_KEY = "__no_campaign__";
export const NO_CAMPAIGN_LABEL = "Deleted campaign";

function campaignKey(id: string | null): string {
  return id ?? NO_CAMPAIGN_KEY;
}

// Day bounds in Eastern time so evening calls land on the right ET day.
function startOfDay(day: string): string {
  return etDayRangeUtc(day).startUtc;
}
function endOfDay(day: string): string {
  return endOfEtDayUtcIso(day);
}

const COSTS_PAGE = 1000;

export async function fetchCostRows(
  supabase: SupabaseClient,
  slicers: Slicers,
): Promise<CostsRow[]> {
  // Paginate past PostgREST's 1,000-row cap — a cost window can exceed 1,000
  // calls, and an un-paginated fetch silently undercounts every spend rollup
  // (vendor split, per-campaign, per-day, …).
  let rows: CostsRow[] = [];
  for (let offset = 0; ; offset += COSTS_PAGE) {
    let query = supabase
      .from("calls")
      .select(
        "id, lead_id, campaign_id, goal_met, duration_seconds, cost_breakdown, started_at, created_at",
      )
      .gte("created_at", startOfDay(slicers.from))
      .lte("created_at", endOfDay(slicers.to))
      .order("created_at", { ascending: false })
      .range(offset, offset + COSTS_PAGE - 1);
    if (slicers.campaignId) query = query.eq("campaign_id", slicers.campaignId);
    const { data } = await query;
    const batch = (data ?? []) as unknown as CostsRow[];
    rows.push(...batch);
    if (batch.length < COSTS_PAGE) break;
    if (offset > 500_000) break; // safety backstop
  }

  if (slicers.ownerId || slicers.listId) {
    const leadIds = Array.from(new Set(rows.map((r) => r.lead_id)));
    if (leadIds.length === 0) return [];
    // Chunk the id filter at ID_CHUNK (200): a `.in("id", …)` of ~1,000 UUIDs
    // overflows the request URL and PostgREST 400s — which (silently swallowed)
    // dropped every row and made an owner/list-filtered Costs page read empty.
    // Fail loud on a query error rather than returning a wrong (empty) total.
    const ok = new Set<string>();
    for (const idChunk of chunk(leadIds, ID_CHUNK)) {
      let leadQuery = supabase.from("leads").select("id").in("id", idChunk);
      if (slicers.listId) leadQuery = leadQuery.eq("list_id", slicers.listId);
      if (slicers.ownerId)
        leadQuery = leadQuery.eq("owner_id", slicers.ownerId);
      const { data: leads, error } = await leadQuery;
      if (error) {
        throw new Error(`Costs lead lookup failed: ${error.message}`);
      }
      for (const l of leads ?? []) ok.add((l as { id: string }).id);
    }
    rows = rows.filter((r) => ok.has(r.lead_id));
  }
  return rows;
}

/** A pre-aggregated row from cost_rollup_daily: spend + counts for one ET day ×
 *  campaign × list × owner. The Costs page reads these instead of scanning
 *  every call (see migration 20260714150000_cost_rollup_daily). */
export type RollupRow = {
  et_day: string;
  /** NULL for calls whose campaign was deleted. */
  campaign_id: string | null;
  list_id: string;
  owner_id: string;
  calls: number;
  /** goal_met CALLS — kept for compatibility; the page shows goal_leads. */
  goal_met: number;
  /** Distinct businesses (lead_id) that hit the goal — what every other
   *  surface calls "Goals met". */
  goal_leads: number;
  twilio: number;
  elevenlabs: number;
  elevenlabs_llm: number;
  elevenlabs_voice: number;
  elevenlabs_credits: number;
  elevenlabs_llm_credits: number;
  elevenlabs_voice_credits: number;
  openai: number;
  lookup: number;
  total: number;
  refreshed_at: string;
};

const ROLLUP_SELECT =
  "et_day, campaign_id, list_id, owner_id, calls, goal_met, goal_leads, twilio, elevenlabs, elevenlabs_llm, elevenlabs_voice, elevenlabs_credits, elevenlabs_llm_credits, elevenlabs_voice_credits, openai, lookup, total, refreshed_at";

/** Turn a rollup row's numeric spend columns into a Breakdown. */
function rowBreakdown(r: RollupRow): Breakdown {
  return {
    twilio: Number(r.twilio),
    elevenlabs: Number(r.elevenlabs),
    elevenlabsLlm: Number(r.elevenlabs_llm),
    elevenlabsVoice: Number(r.elevenlabs_voice),
    elevenlabsCredits: Number(r.elevenlabs_credits),
    elevenlabsLlmCredits: Number(r.elevenlabs_llm_credits),
    elevenlabsVoiceCredits: Number(r.elevenlabs_voice_credits),
    openai: Number(r.openai),
    lookup: Number(r.lookup),
    total: Number(r.total),
  };
}

/** Read pre-aggregated rollup rows for the window + slicers — the fast path that
 *  replaces the per-call fetchCostRows for every page aggregation
 *  (vendor/campaign/list/user/goal/time). The rollup is small (days × campaigns
 *  × lists × owners) but we paginate for safety. RLS scopes rows to the owner;
 *  admins see all — matching the old lead-ownership filtering. */
export async function fetchRollupRows(
  supabase: SupabaseClient,
  slicers: Slicers,
): Promise<RollupRow[]> {
  const rows: RollupRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    let query = supabase
      .from("cost_rollup_daily")
      .select(ROLLUP_SELECT)
      .gte("et_day", slicers.from)
      .lte("et_day", slicers.to)
      .order("et_day", { ascending: true })
      .range(offset, offset + 999);
    if (slicers.campaignId) query = query.eq("campaign_id", slicers.campaignId);
    if (slicers.listId) query = query.eq("list_id", slicers.listId);
    if (slicers.ownerId) query = query.eq("owner_id", slicers.ownerId);
    const { data } = await query;
    const batch = (data ?? []) as unknown as RollupRow[];
    rows.push(...batch);
    if (batch.length < 1000) break;
    if (offset > 500_000) break; // safety backstop
  }
  return rows;
}

/** The most recent `refreshed_at` across the rows (the cron rewrites recent
 *  days every 10 minutes), for an "Updated …" stamp. Null when empty. */
export function latestRefreshedAt(rows: RollupRow[]): string | null {
  let max: string | null = null;
  for (const r of rows) {
    if (r.refreshed_at && (!max || r.refreshed_at > max)) max = r.refreshed_at;
  }
  return max;
}

/** Total Twilio Lookup spend recorded outside calls (lead-import lookups)
 *  within the window. Optionally scoped to one owner; campaign/list slicers
 *  don't apply since these charges aren't tied to a call. */
export async function fetchLookupChargeTotal(
  supabase: SupabaseClient,
  slicers: Pick<Slicers, "from" | "to" | "ownerId">,
): Promise<number> {
  // Paged: a bare select stops at 1,000 rows, and this total feeds the Costs
  // headline — a big import day would silently under-report its lookup spend.
  const rows = await fetchAllRows<{ cost: number }>((from, to) => {
    let query = supabase
      .from("lookup_charges")
      .select("cost")
      .gte("created_at", startOfDay(slicers.from))
      .lte("created_at", endOfDay(slicers.to));
    if (slicers.ownerId) query = query.eq("owner_id", slicers.ownerId);
    return query
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
  });
  return rows.reduce((sum, r) => sum + (Number(r.cost) || 0), 0);
}

export type AiChargeKindTotal = { kind: string; count: number; cost: number };

export type AiChargeTotals = {
  total: number;
  byKind: AiChargeKindTotal[];
};

/** AI spend recorded outside a call's cost_breakdown (`ai_charges`: Ask
 *  Smile, agent drafting, template splitting, script tidying, live business
 *  research, ElevenLabs test calls) within the window, in total and by kind.
 *  Optionally scoped to one owner; campaign/list slicers don't apply. */
export async function fetchAiChargeTotals(
  supabase: SupabaseClient,
  slicers: Pick<Slicers, "from" | "to" | "ownerId">,
): Promise<AiChargeTotals> {
  const rows = await fetchAllRows<{ kind: string; cost: number }>(
    (from, to) => {
      let query = supabase
        .from("ai_charges")
        .select("kind, cost")
        .gte("created_at", startOfDay(slicers.from))
        .lte("created_at", endOfDay(slicers.to));
      if (slicers.ownerId) query = query.eq("owner_id", slicers.ownerId);
      return query
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
    },
  );
  const acc = new Map<string, { count: number; cost: number }>();
  let total = 0;
  for (const r of rows) {
    const cost = Number(r.cost) || 0;
    total += cost;
    const cur = acc.get(r.kind) ?? { count: 0, cost: 0 };
    cur.count += 1;
    cur.cost += cost;
    acc.set(r.kind, cur);
  }
  return {
    total,
    byKind: [...acc.entries()]
      .map(([kind, v]) => ({ kind, count: v.count, cost: v.cost }))
      .sort((a, b) => b.cost - a.cost),
  };
}

export type PerCampaign = {
  /** A campaign id, or NO_CAMPAIGN_KEY for calls whose campaign was deleted. */
  campaignId: string;
  calls: number;
  goalMet: number;
  spend: Breakdown;
  avgPerCall: number;
  costPerGoalMet: number;
};

export function rollupByCampaign(rows: RollupRow[]): PerCampaign[] {
  const acc = new Map<
    string,
    { calls: number; goalMet: number; spend: Breakdown }
  >();
  for (const r of rows) {
    const key = campaignKey(r.campaign_id);
    const cur = acc.get(key) ?? {
      calls: 0,
      goalMet: 0,
      spend: zeroBreakdown(),
    };
    cur.calls += r.calls;
    cur.goalMet += r.goal_leads;
    addBreakdownInto(cur.spend, rowBreakdown(r));
    acc.set(key, cur);
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

export function rollupByGoalMet(rows: RollupRow[]): PerGoal[] {
  const acc = new Map<string, { goalMet: number; spend: number }>();
  for (const r of rows) {
    const key = campaignKey(r.campaign_id);
    const cur = acc.get(key) ?? { goalMet: 0, spend: 0 };
    cur.goalMet += r.goal_leads;
    cur.spend += Number(r.total);
    acc.set(key, cur);
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

/** Per-user rollup — the rollup row already carries owner_id, so no lead
 *  lookup is needed (and the RLS on cost_rollup_daily already scoped rows). */
export function rollupByUser(rows: RollupRow[]): PerUser[] {
  const acc = new Map<string, { calls: number; spend: number }>();
  for (const r of rows) {
    const cur = acc.get(r.owner_id) ?? { calls: 0, spend: 0 };
    cur.calls += r.calls;
    cur.spend += Number(r.total);
    acc.set(r.owner_id, cur);
  }
  return [...acc.entries()]
    .map(([ownerId, v]) => ({
      ownerId,
      calls: v.calls,
      spend: v.spend,
    }))
    .sort((a, b) => b.spend - a.spend);
}

export type PerList = {
  listId: string;
  calls: number;
  goalMet: number;
  spend: number;
};

/** Per-list rollup — the rollup row already carries list_id, so no lead
 *  lookup is needed. */
export function rollupByList(rows: RollupRow[]): PerList[] {
  const acc = new Map<
    string,
    { calls: number; goalMet: number; spend: number }
  >();
  for (const r of rows) {
    const cur = acc.get(r.list_id) ?? { calls: 0, goalMet: 0, spend: 0 };
    cur.calls += r.calls;
    cur.goalMet += r.goal_leads;
    cur.spend += Number(r.total);
    acc.set(r.list_id, cur);
  }
  return [...acc.entries()]
    .map(([listId, v]) => ({
      listId,
      calls: v.calls,
      goalMet: v.goalMet,
      spend: v.spend,
    }))
    .sort((a, b) => b.spend - a.spend);
}

export type PerTime = { day: string; spend: number; calls: number };

export function rollupByTime(rows: RollupRow[], slicers: Slicers): PerTime[] {
  const buckets = new Map<string, { spend: number; calls: number }>();
  const start = new Date(`${slicers.from}T00:00:00Z`);
  const end = new Date(`${slicers.to}T00:00:00Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    buckets.set(d.toISOString().slice(0, 10), { spend: 0, calls: 0 });
  }
  for (const r of rows) {
    const cur = buckets.get(r.et_day) ?? { spend: 0, calls: 0 };
    cur.spend += Number(r.total);
    cur.calls += r.calls;
    buckets.set(r.et_day, cur);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, v]) => ({ day, spend: v.spend, calls: v.calls }));
}

export function rollupByVendor(rows: RollupRow[]): Breakdown {
  const acc = zeroBreakdown();
  for (const r of rows) addBreakdownInto(acc, rowBreakdown(r));
  return acc;
}

export function resolveDatePreset(
  preset: string,
  custom: { from?: string; to?: string },
): { from: string; to: string } {
  const todayStr = etDayString();
  const daysAgo = (n: number) => etDateDaysAgo(n);
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
