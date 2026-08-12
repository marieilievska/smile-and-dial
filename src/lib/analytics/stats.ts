import type { SupabaseClient } from "@supabase/supabase-js";

// Canonical outcome groupings — shared across every metric surface so connect
// rate (and conversation / DM-reached) means the same thing everywhere.
import {
  CONNECTED_OUTCOMES,
  CONVERSATION_OUTCOMES,
} from "@/lib/calls/outcomes";
import { ID_CHUNK, chunk } from "@/lib/leads/chunk";
import {
  endOfEtDayUtcIso,
  etDateDaysAgo,
  etDayRangeUtc,
  etDayString,
} from "@/lib/time/eastern";

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
  /** Distinct businesses that met the goal AND where we reached the decision-
   *  maker. A subset of goalMet — a goal can be met without a DM (a gatekeeper
   *  books it, a survey is completed), so these two are reported separately. */
  goalMetWithDm: number;
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
  // unitemized cost is never dropped. Mirrors pickBreakdown in costs.ts —
  // which folds openai_review (Call-Reviewer spend, stored as a SEPARATE key)
  // into openai; omitting it here made /analytics undercount vs /costs.
  const componentSum =
    n("twilio") + n("elevenlabs") + n("openai") + n("openai_review") + n("lookup");
  return componentSum > 0 ? componentSum : n("total");
}

// Day bounds in Eastern time, so a range like "Jun 1–Jun 1" captures the full
// ET calendar day (incl. evening calls), not the UTC day.
function startOfDay(day: string): string {
  return etDayRangeUtc(day).startUtc;
}
function endOfDay(day: string): string {
  return endOfEtDayUtcIso(day);
}

const PAGE = 1000;

/** Pull every call row that matches the slicers, then filter/aggregate in JS so
 *  we compute KPIs + charts + funnel + compare-period deltas from one dataset.
 *
 *  Paginated: PostgREST caps a single response at 1,000 rows, and an analytics
 *  window can hold far more calls than that — a capped fetch silently
 *  undercounts EVERY metric (calls made, funnel, time chart, …). We page through
 *  in 1,000-row batches until exhausted. */
export async function fetchCallsForRange(
  supabase: SupabaseClient,
  slicers: Slicers,
): Promise<CallRow[]> {
  let rows: CallRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    let query = supabase
      .from("calls")
      .select(
        "id, campaign_id, lead_id, direction, outcome, goal_met, duration_seconds, " +
          "talk_time_seconds, cost_breakdown, extracted_data, started_at, created_at",
      )
      .gte("created_at", startOfDay(slicers.from))
      .lte("created_at", endOfDay(slicers.to))
      .order("created_at", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (slicers.campaignId) query = query.eq("campaign_id", slicers.campaignId);
    const { data } = await query;
    const batch = (data ?? []) as unknown as CallRow[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
    if (offset > 500_000) break; // safety backstop
  }
  if (rows.length === 0) return [];

  // Join each call's LEAD-level decision_maker_reached flag (the operator-
  // correctable source of truth) so DM-reached metrics reflect manual Yes/No
  // corrections, not the call's frozen AI extraction. The same query also
  // applies the owner / list filters, which live on `leads`, not `calls`.
  //
  // Chunk the id filter at ID_CHUNK (200), NOT the 1,000-row page size: an
  // `.in("id", …)` list of ~1,000 UUIDs makes a ~38 KB request URL, which
  // PostgREST rejects with a 400. The old code chunked at 1,000 and swallowed
  // the error, so on any window with >~250 leads EVERY DM flag silently read
  // false — which zeroed "Decision-makers reached" and pinned Goal rate at a
  // fake 100%. Fail LOUD on a query error instead of returning confident-but-
  // wrong numbers.
  const leadIds = Array.from(new Set(rows.map((r) => r.lead_id)));
  const dmByLead = new Map<string, boolean>();
  for (const idChunk of chunk(leadIds, ID_CHUNK)) {
    let leadQuery = supabase
      .from("leads")
      .select("id, decision_maker_reached")
      .in("id", idChunk);
    if (slicers.listId) leadQuery = leadQuery.eq("list_id", slicers.listId);
    if (slicers.ownerId) leadQuery = leadQuery.eq("owner_id", slicers.ownerId);
    const { data: leads, error } = await leadQuery;
    if (error) {
      throw new Error(`Analytics lead lookup failed: ${error.message}`);
    }
    for (const l of leads ?? []) {
      dmByLead.set(l.id, l.decision_maker_reached === true);
    }
  }

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
  // ai_error = OUR quota/platform failure, not a real call. Counted out of the
  // connect-rate denominator so an EL credit outage neither inflates nor tanks
  // the rate (see NON_CALL_OUTCOMES / CONNECTED_OUTCOMES in calls/outcomes.ts).
  let aiError = 0;
  // Goals are counted per BUSINESS, not per call: a lead with two goal-met calls
  // (called twice, or two leads merged into one) is ONE win. Dedupe by lead_id.
  const goalLeadIds = new Set<string>();
  // The subset of those businesses where we also reached the decision-maker.
  const goalDmLeadIds = new Set<string>();
  let durationSum = 0;
  let durationCount = 0;
  let spend = 0;
  for (const r of rows) {
    if (r.outcome && CONNECTED_OUTCOMES.has(r.outcome)) connected += 1;
    if (r.outcome === "ai_error") aiError += 1;
    if (r.outcome && CONVERSATION_OUTCOMES.has(r.outcome)) conversations += 1;
    if (rowReachedDm(r)) dmsReached += 1;
    if (r.goal_met) {
      goalLeadIds.add(r.lead_id);
      if (rowReachedDm(r)) goalDmLeadIds.add(r.lead_id);
    }
    if (r.duration_seconds != null) {
      durationSum += r.duration_seconds;
      durationCount += 1;
    }
    spend += pickCostTotal(r.cost_breakdown);
  }
  const goalMet = goalLeadIds.size;
  const goalMetWithDm = goalDmLeadIds.size;
  return {
    totalCalls,
    conversations,
    dmsReached,
    connected,
    connectRate:
      totalCalls - aiError <= 0 ? 0 : connected / (totalCalls - aiError),
    goalMet,
    goalMetWithDm,
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

/** Per-BUSINESS conversion funnel — counts DISTINCT leads at each stage so the
 *  funnel narrows cleanly into a true subset chain (unlike the per-call version,
 *  where sticky lead flags like DM-reached can make a later stage exceed an
 *  earlier one). A lead enters a stage when ANY of its calls in range qualifies.
 *  "Conversations" means a real talk: talk time passed one minute.
 *
 *  The funnel is the "how far into the conversation did we get" chain and now
 *  ENDS at decision-makers reached. Goals met is deliberately NOT the last step:
 *  a goal can be met without reaching the decision-maker (a gatekeeper books the
 *  slot, a survey is completed), so goals are not a subset of DMs. Forcing them
 *  to be (the old code did) inflated the DM count to equal goals and pinned the
 *  goal rate at a fake 100%. Goals met is now reported on its own beside the
 *  funnel — as a total and a decision-maker subset. */
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
  // Enforce a TRUE funnel: a lead in a deeper stage implies every shallower one.
  // Sticky lead flags aren't set in lockstep with in-window calls (a lead can be
  // DM-reached from a prior call yet only hit voicemail this window), so fold
  // each deeper stage upward to keep the chain narrowing monotonically and every
  // step rate ≤ 100%. A met goal IS by definition a real conversation, so fold
  // goals into the conversation stage too — this keeps the separate goal-vs-
  // conversation rate ≤ 100% without making goals a child of the DM stage.
  const dms = dmRaw;
  const conversations = new Set([...conversationRaw, ...goalRaw, ...dms]);
  const connected = new Set([...connectedRaw, ...conversations]);
  return [
    { label: "Called", count: called.size },
    { label: "Connected", count: connected.size },
    { label: "Conversations", count: conversations.size },
    { label: "Decision-makers reached", count: dms.size },
  ];
}

/** Daily count of businesses that met the goal — the trend series for the
 *  Appointments Booked hero chart and sparkline. Counts DISTINCT leads per day
 *  (a lead with two goal-met calls the same day is one win), matching the
 *  per-business KPI. Same date-pre-seeding trick as callsByDay so the chart
 *  never has gaps. */
export function bookingsByDay(rows: CallRow[], slicers: Slicers): number[] {
  const buckets = new Map<string, Set<string>>();
  const start = new Date(`${slicers.from}T00:00:00Z`);
  const end = new Date(`${slicers.to}T00:00:00Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    buckets.set(d.toISOString().slice(0, 10), new Set());
  }
  for (const r of rows) {
    if (!r.goal_met) continue;
    const day = etDayString(new Date(r.created_at));
    let leads = buckets.get(day);
    if (!leads) {
      leads = new Set();
      buckets.set(day, leads);
    }
    leads.add(r.lead_id);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, leads]) => leads.size);
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
    const day = etDayString(new Date(r.created_at));
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
  // goalMet is DISTINCT leads per campaign — a business that converted counts
  // once for its campaign, even with multiple goal-met calls. A business that
  // hit its goal under two campaigns is credited to EACH (once), so the per-
  // campaign rows can sum higher than the global distinct-business total.
  const acc = new Map<string, { goalLeads: Set<string>; spend: number }>();
  for (const r of rows) {
    const v = acc.get(r.campaign_id) ?? { goalLeads: new Set(), spend: 0 };
    if (r.goal_met) v.goalLeads.add(r.lead_id);
    v.spend += pickCostTotal(r.cost_breakdown);
    acc.set(r.campaign_id, v);
  }
  return [...acc.entries()]
    .map(([campaignId, v]) => {
      const goalMet = v.goalLeads.size;
      return {
        campaignId,
        campaignName: names.get(campaignId) ?? "—",
        goalMet,
        spend: v.spend,
        costPerGoalMet: goalMet === 0 ? 0 : v.spend / goalMet,
      };
    })
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
  const todayStr = etDayString();
  const daysAgo = (n: number) => etDateDaysAgo(n);
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
