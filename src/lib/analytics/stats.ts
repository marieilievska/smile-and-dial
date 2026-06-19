import type { SupabaseClient } from "@supabase/supabase-js";

// Canonical outcome groupings — shared across every metric surface so connect
// rate (and conversation / DM-reached) means the same thing everywhere.
import {
  CONNECTED_OUTCOMES,
  CONVERSATION_OUTCOMES,
} from "@/lib/calls/outcomes";

export type CallRow = {
  id: string;
  campaign_id: string;
  lead_id: string;
  direction: "inbound" | "outbound";
  outcome: string | null;
  goal_met: boolean;
  duration_seconds: number | null;
  talk_time_seconds: number | null;
  cost_breakdown: unknown;
  extracted_data: unknown;
  /** The LEAD's sticky decision_maker_reached flag (operator-correctable),
   *  joined in by fetchCallsForRange. DM-reached metrics count THIS, not the
   *  call's frozen AI extraction, so a manual Yes/No correction on the lead is
   *  reflected in analytics. */
  lead_decision_maker_reached: boolean;
  started_at: string | null;
  created_at: string;
};

/** Does this call's LEAD count as "decision maker reached"? Reads the lead's
 *  sticky decision_maker_reached flag (joined in by fetchCallsForRange), NOT
 *  the call's frozen AI extraction. The flag is what the post-call webhook sets
 *  automatically AND what an operator can correct with the lead's Yes/No
 *  toggle — so a manual correction is reflected in these metrics instead of the
 *  metric showing a stale "yes" the operator already overrode. */
export function rowReachedDm(row: {
  lead_decision_maker_reached?: boolean;
}): boolean {
  return row.lead_decision_maker_reached === true;
}

export type Slicers = {
  campaignId?: string;
  ownerId?: string;
  /** Filter calls whose lead is in this list. */
  listId?: string;
  /** ISO date inclusive (YYYY-MM-DD). */
  from: string;
  /** ISO date inclusive (YYYY-MM-DD). */
  to: string;
};

export type Kpis = {
  totalCalls: number;
  conversations: number;
  dmsReached: number;
  connected: number;
  connectRate: number; // 0..1
  goalMet: number;
  goalMetRate: number; // 0..1, vs conversations
  avgDurationSeconds: number;
  avgCostPerCall: number;
  costPerGoalMet: number;
  callbacksScheduled: number;
  dncAdditions: number;
  totalSpend: number;
};

export type OutcomeBucket = { outcome: string; count: number };

export type FunnelStep = { label: string; count: number };

export type TimeBucket = { day: string; count: number; spend: number };

function pickCostTotal(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const v = value as Record<string, unknown>;
  const n = (k: string) =>
    typeof v[k] === "number" && Number.isFinite(v[k] as number)
      ? (v[k] as number)
      : 0;
  // Prefer the sum of itemized vendor costs over the stored `total`, which
  // can be missing or stale relative to the parts. Fall back to the stored
  // total only when there's no itemization (legacy rows), so a real-but-
  // unitemized cost is never dropped. Mirrors pickBreakdown in costs.ts.
  const componentSum =
    n("twilio") + n("elevenlabs") + n("openai") + n("lookup");
  return componentSum > 0 ? componentSum : n("total");
}

function startOfDay(day: string): string {
  return `${day}T00:00:00.000Z`;
}
function endOfDay(day: string): string {
  return `${day}T23:59:59.999Z`;
}

/** Pull every call row that matches the slicers — single round-trip. The page
 *  filters and aggregates in JS so we can compute KPIs + charts + funnel +
 *  compare-period deltas from one fetch. */
export async function fetchCallsForRange(
  supabase: SupabaseClient,
  slicers: Slicers,
): Promise<CallRow[]> {
  let query = supabase
    .from("calls")
    .select(
      "id, campaign_id, lead_id, direction, outcome, goal_met, duration_seconds, " +
        "talk_time_seconds, cost_breakdown, extracted_data, started_at, created_at",
    )
    .gte("created_at", startOfDay(slicers.from))
    .lte("created_at", endOfDay(slicers.to))
    .order("created_at", { ascending: true });
  if (slicers.campaignId) query = query.eq("campaign_id", slicers.campaignId);

  const { data } = await query;
  let rows = (data ?? []) as unknown as CallRow[];
  if (rows.length === 0) return [];

  // Join each call's LEAD-level decision_maker_reached flag (the operator-
  // correctable source of truth) so DM-reached metrics reflect manual Yes/No
  // corrections, not the call's frozen AI extraction. The same query also
  // applies the owner / list filters, which live on `leads`, not `calls`.
  const leadIds = Array.from(new Set(rows.map((r) => r.lead_id)));
  let leadQuery = supabase
    .from("leads")
    .select("id, decision_maker_reached")
    .in("id", leadIds);
  if (slicers.listId) leadQuery = leadQuery.eq("list_id", slicers.listId);
  if (slicers.ownerId) leadQuery = leadQuery.eq("owner_id", slicers.ownerId);
  const { data: leads } = await leadQuery;
  const dmByLead = new Map(
    (leads ?? []).map((l) => [l.id, l.decision_maker_reached === true]),
  );

  // When an owner/list filter is set, drop calls whose lead fell outside it.
  if (slicers.ownerId || slicers.listId) {
    rows = rows.filter((r) => dmByLead.has(r.lead_id));
  }
  for (const r of rows) {
    r.lead_decision_maker_reached = dmByLead.get(r.lead_id) ?? false;
  }

  return rows;
}

export function computeKpis(rows: CallRow[]): Kpis {
  const totalCalls = rows.length;
  let conversations = 0;
  let dmsReached = 0;
  let connected = 0;
  let goalMet = 0;
  let durationSum = 0;
  let durationCount = 0;
  let spend = 0;
  for (const r of rows) {
    if (r.outcome && CONNECTED_OUTCOMES.has(r.outcome)) connected += 1;
    if (r.outcome && CONVERSATION_OUTCOMES.has(r.outcome)) conversations += 1;
    if (rowReachedDm(r)) dmsReached += 1;
    if (r.goal_met) goalMet += 1;
    if (r.duration_seconds != null) {
      durationSum += r.duration_seconds;
      durationCount += 1;
    }
    spend += pickCostTotal(r.cost_breakdown);
  }
  return {
    totalCalls,
    conversations,
    dmsReached,
    connected,
    connectRate: totalCalls === 0 ? 0 : connected / totalCalls,
    goalMet,
    goalMetRate: conversations === 0 ? 0 : goalMet / conversations,
    avgDurationSeconds: durationCount === 0 ? 0 : durationSum / durationCount,
    avgCostPerCall: totalCalls === 0 ? 0 : spend / totalCalls,
    costPerGoalMet: goalMet === 0 ? 0 : spend / goalMet,
    callbacksScheduled: rows.filter((r) => r.outcome === "callback").length,
    dncAdditions: rows.filter((r) => r.outcome === "dnc").length,
    totalSpend: spend,
  };
}

export function outcomeDistribution(rows: CallRow[]): OutcomeBucket[] {
  const buckets = new Map<string, number>();
  for (const r of rows) {
    const key = r.outcome ?? "no_outcome";
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .map(([outcome, count]) => ({ outcome, count }))
    .sort((a, b) => b.count - a.count);
}

export function buildFunnel(rows: CallRow[]): FunnelStep[] {
  let dialed = 0;
  let connected = 0;
  let conversation = 0;
  let dmsReached = 0;
  let goalMet = 0;
  for (const r of rows) {
    dialed += 1;
    if (r.outcome && CONNECTED_OUTCOMES.has(r.outcome)) connected += 1;
    if (r.outcome && CONVERSATION_OUTCOMES.has(r.outcome)) conversation += 1;
    if (rowReachedDm(r)) dmsReached += 1;
    if (r.goal_met) goalMet += 1;
  }
  return [
    { label: "Dialed", count: dialed },
    { label: "Connected", count: connected },
    { label: "Conversation", count: conversation },
    { label: "DMs Reached", count: dmsReached },
    { label: "Goal Met", count: goalMet },
  ];
}

/** Per-BUSINESS conversion funnel — counts DISTINCT leads at each stage so the
 *  funnel narrows cleanly into a true subset chain (unlike the per-call version,
 *  where sticky lead flags like DM-reached/goal-met can make a later stage
 *  exceed an earlier one). A lead enters a stage when ANY of its calls in range
 *  qualifies. "Conversations" means a real talk: talk time passed one minute. */
export function buildLeadFunnel(rows: CallRow[]): FunnelStep[] {
  const called = new Set<string>();
  const connectedRaw = new Set<string>();
  const conversationRaw = new Set<string>();
  const dmRaw = new Set<string>();
  const goalRaw = new Set<string>();
  for (const r of rows) {
    called.add(r.lead_id);
    const isConnected = !!r.outcome && CONNECTED_OUTCOMES.has(r.outcome);
    if (isConnected) connectedRaw.add(r.lead_id);
    // A real conversation = we reached a person AND talked more than a minute.
    // ElevenLabs never populates talk_time_seconds (it sends call_duration_secs,
    // which the webhook stores in duration_seconds), so the old talk-time check
    // was ALWAYS 0 — the "Conversations: 0" bug. Prefer talk time when present,
    // else fall back to the connected call's duration.
    const talkSecs = r.talk_time_seconds ?? r.duration_seconds ?? 0;
    if (isConnected && talkSecs >= 60) conversationRaw.add(r.lead_id);
    if (rowReachedDm(r)) dmRaw.add(r.lead_id);
    if (r.goal_met) goalRaw.add(r.lead_id);
  }
  // Enforce a TRUE funnel: a lead in a deeper stage implies every shallower one
  // (you can't meet the goal without reaching the DM, having a real
  // conversation, and connecting). The old code counted each stage
  // independently, so sticky lead flags the agent doesn't set in lockstep let a
  // later stage exceed an earlier one — e.g. goals(14) > DMs(12), which rendered
  // as a nonsensical "117% of DMs reached". Folding deeper stages upward makes
  // the chain narrow monotonically and every step rate land at ≤ 100%.
  const goals = goalRaw;
  const dms = new Set([...dmRaw, ...goals]);
  const conversations = new Set([...conversationRaw, ...dms]);
  const connected = new Set([...connectedRaw, ...conversations]);
  return [
    { label: "Called", count: called.size },
    { label: "Connected", count: connected.size },
    { label: "Conversations", count: conversations.size },
    { label: "DMs reached", count: dms.size },
    { label: "Goals met", count: goals.size },
  ];
}

/** Daily count of `goal_met=true` calls — the trend series for the
 *  Appointments Booked hero chart and sparkline. Same date-pre-seeding
 *  trick as callsByDay so the chart never has gaps. */
export function bookingsByDay(rows: CallRow[], slicers: Slicers): number[] {
  const buckets = new Map<string, number>();
  const start = new Date(`${slicers.from}T00:00:00Z`);
  const end = new Date(`${slicers.to}T00:00:00Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    buckets.set(d.toISOString().slice(0, 10), 0);
  }
  for (const r of rows) {
    if (!r.goal_met) continue;
    const day = r.created_at.slice(0, 10);
    buckets.set(day, (buckets.get(day) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, v]) => v);
}

export function callsByDay(rows: CallRow[], slicers: Slicers): TimeBucket[] {
  const buckets = new Map<string, { count: number; spend: number }>();
  // Pre-seed every day in the range so the chart never has gaps.
  const start = new Date(`${slicers.from}T00:00:00Z`);
  const end = new Date(`${slicers.to}T00:00:00Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    buckets.set(d.toISOString().slice(0, 10), { count: 0, spend: 0 });
  }
  for (const r of rows) {
    const day = r.created_at.slice(0, 10);
    const b = buckets.get(day) ?? { count: 0, spend: 0 };
    b.count += 1;
    b.spend += pickCostTotal(r.cost_breakdown);
    buckets.set(day, b);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, v]) => ({ day, count: v.count, spend: v.spend }));
}

export type CampaignRank = {
  campaignId: string;
  campaignName: string;
  goalMet: number;
  spend: number;
  costPerGoalMet: number;
};

export function rankCampaigns(
  rows: CallRow[],
  names: Map<string, string>,
): CampaignRank[] {
  const acc = new Map<string, { goalMet: number; spend: number }>();
  for (const r of rows) {
    const v = acc.get(r.campaign_id) ?? { goalMet: 0, spend: 0 };
    if (r.goal_met) v.goalMet += 1;
    v.spend += pickCostTotal(r.cost_breakdown);
    acc.set(r.campaign_id, v);
  }
  return [...acc.entries()]
    .map(([campaignId, v]) => ({
      campaignId,
      campaignName: names.get(campaignId) ?? "—",
      goalMet: v.goalMet,
      spend: v.spend,
      costPerGoalMet: v.goalMet === 0 ? 0 : v.spend / v.goalMet,
    }))
    .sort((a, b) => b.goalMet - a.goalMet);
}

/** Compute the previous comparable window of the same length, ending the day
 *  before `from`. Returns the dates as YYYY-MM-DD. */
export function previousPeriod(slicers: Slicers): { from: string; to: string } {
  const start = new Date(`${slicers.from}T00:00:00Z`);
  const end = new Date(`${slicers.to}T00:00:00Z`);
  const lengthDays =
    Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const prevEnd = new Date(start);
  prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - (lengthDays - 1));
  return {
    from: prevStart.toISOString().slice(0, 10),
    to: prevEnd.toISOString().slice(0, 10),
  };
}

/** Resolve a preset to {from,to}. Returns today + today as a safe default. */
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
    case "yesterday":
      return { from: daysAgo(1), to: daysAgo(1) };
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

/** Tiny delta helper for compare-periods tiles. */
export function pctDelta(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return (current - previous) / previous;
}

export type AnalyticsInsight = {
  /** One-sentence read on the headline metric (appointments + trend). */
  headline: string;
  /** Optional supporting sentence (biggest funnel leak + cost). */
  detail: string | null;
  /** Trend direction for the headline, used to tint the insight card.
   *  "up" = improving, "down" = worsening, "flat" = no meaningful change,
   *  "none" = no prior to compare against. */
  tone: "up" | "down" | "flat" | "none";
};

/** Deterministic "AI read" of the period — no LLM call, no cost, no
 *  flakiness. Turns the numbers we already compute into a plain-English
 *  sentence or two, the way a 2026 product interprets a dashboard for
 *  you instead of leaving you to eyeball it. */
export function buildInsights(opts: {
  kpis: Kpis;
  prior: Kpis | null;
  funnel: FunnelStep[];
  ranking: CampaignRank[];
}): AnalyticsInsight {
  const { kpis, prior, funnel, ranking } = opts;

  if (kpis.totalCalls === 0) {
    return {
      headline: "No calls landed in this window yet.",
      detail: "Pick a wider date range, or let your campaigns keep dialing.",
      tone: "none",
    };
  }

  const appts = `${kpis.goalMet.toLocaleString()} goal${
    kpis.goalMet === 1 ? "" : "s"
  } met`;
  const leader = ranking.find((r) => r.goalMet > 0);
  const lead = leader ? `, led by ${leader.campaignName}` : "";

  // Headline — goals met + trend vs the prior period when we have one.
  let headline: string;
  let tone: AnalyticsInsight["tone"];
  const delta = prior ? pctDelta(kpis.goalMet, prior.goalMet) : null;
  if (prior && prior.goalMet > 0 && delta != null) {
    if (Math.abs(delta) < 0.005) {
      headline = `${appts} — flat vs the prior period${lead}.`;
      tone = "flat";
    } else {
      const dir = delta > 0 ? "up" : "down";
      headline = `Goals met are ${dir} ${Math.abs(delta * 100).toFixed(
        0,
      )}% vs the prior period — ${appts} against ${prior.goalMet}${lead}.`;
      tone = delta > 0 ? "up" : "down";
    }
  } else {
    headline = `${appts} in this window${lead}.`;
    tone = "none";
  }

  // Detail — biggest funnel leak (largest step-over-step drop), then the
  // all-in cost per appointment when we have bookings.
  const parts: string[] = [];
  let worst: { from: string; to: string; drop: number } | null = null;
  for (let i = 1; i < funnel.length; i++) {
    const prev = funnel[i - 1].count;
    const cur = funnel[i].count;
    if (prev > 0) {
      const drop = (prev - cur) / prev;
      if (worst == null || drop > worst.drop) {
        worst = { from: funnel[i - 1].label, to: funnel[i].label, drop };
      }
    }
  }
  if (worst && worst.drop > 0.005) {
    parts.push(
      `Biggest drop-off is ${worst.from} → ${worst.to}, losing ${(
        worst.drop * 100
      ).toFixed(0)}% of calls.`,
    );
  }
  if (kpis.goalMet > 0 && kpis.costPerGoalMet > 0) {
    parts.push(
      `Each goal met costs $${kpis.costPerGoalMet.toFixed(2)} all-in.`,
    );
  }

  return { headline, detail: parts.length > 0 ? parts.join(" ") : null, tone };
}
