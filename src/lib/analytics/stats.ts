import type { SupabaseClient } from "@supabase/supabase-js";

import { breakdownTotal } from "@/lib/costs/breakdown";

// Canonical outcome groupings — shared across every metric surface so connect
// rate (and conversation / DM-reached) means the same thing everywhere.
import {
  CONNECTED_OUTCOMES,
  CONVERSATION_OUTCOMES,
} from "@/lib/calls/outcomes";
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
  /** The LEAD's sticky decision_maker_reached flag (operator-correctable).
   *  DM-reached metrics count THIS, not the call's frozen AI extraction, so a
   *  manual Yes/No correction on the lead is reflected in analytics. The SQL
   *  path reads the same column; see `dm` in analytics_summary. */
  lead_decision_maker_reached: boolean;
  started_at: string | null;
  created_at: string;
};

/** Does this call's LEAD count as "decision maker reached"? Reads the lead's
 *  sticky decision_maker_reached flag, NOT the call's frozen AI extraction. The flag is what the post-call webhook sets
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

/** A call's cost — the one definition in lib/costs/breakdown (component sum,
 *  falling back to the stored total for un-itemized legacy rows), so
 *  /analytics can never undercount vs /costs again. */
function pickCostTotal(value: unknown): number {
  return breakdownTotal(value);
}

// Day bounds in Eastern time, so a range like "Jun 1–Jun 1" captures the full
// ET calendar day (incl. evening calls), not the UTC day.
function startOfDay(day: string): string {
  return etDayRangeUtc(day).startUtc;
}
function endOfDay(day: string): string {
  return endOfEtDayUtcIso(day);
}

/* ---------------------------------------------------------------------------
 * The row-based aggregators below are the EXECUTABLE SPECIFICATION.
 *
 * They no longer run in production — `analytics_summary` does the counting in
 * SQL now (see the bottom of this file). They are kept, and kept tested,
 * because the counting rules they encode are ones this app has got wrong
 * before and cannot afford to get wrong again:
 *
 *   * goals are distinct BUSINESSES, never goal-met calls (#279)
 *   * goalMetWithDm is a subset of goalMet, not the same number
 *   * the funnel folds so it narrows monotonically
 *   * a lead that hits its goal under two campaigns is credited to each, once
 *   * a lead with two goal-met calls on one day is one booking that day
 *
 * Written here in a language you can unit-test, they are what the SQL was
 * translated from and what it is checked against. The check is not a claim in
 * a commit message: `node scripts/verify-analytics-parity.mjs` runs both paths
 * over the same production windows and diffs every number.
 *
 * The paged FETCH that used to feed them is gone. It pulled ~8k call rows per
 * window, twice per page load, and nothing should reach for it again.
 * ------------------------------------------------------------------------ */

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
  return deriveKpis({
    totalCalls,
    connected,
    aiError,
    conversations,
    dmsReached,
    goalMet: goalLeadIds.size,
    goalMetWithDm: goalDmLeadIds.size,
    durationSum,
    durationCount,
    spend,
    callbacksScheduled: rows.filter((r) => r.outcome === "callback").length,
    dncAdditions: rows.filter((r) => r.outcome === "dnc").length,
  });
}

/** The raw counts a KPI block is built from — no ratios, no averages.
 *
 *  Produced two ways that must never disagree: by counting rows in JS
 *  (computeKpis) and by `analytics_summary` in SQL. Both hand the components
 *  to deriveKpis below, so the division rules exist ONCE. */
export type KpiComponents = {
  totalCalls: number;
  connected: number;
  /** OUR platform failures. Out of the connect-rate denominator entirely. */
  aiError: number;
  conversations: number;
  dmsReached: number;
  /** Distinct BUSINESSES, never goal-met calls (#279). */
  goalMet: number;
  goalMetWithDm: number;
  durationSum: number;
  durationCount: number;
  spend: number;
  callbacksScheduled: number;
  dncAdditions: number;
};

/** Turn raw counts into the displayed KPIs. The only place these ratios are
 *  computed, and the only place their divide-by-zero rules live. */
export function deriveKpis(c: KpiComponents): Kpis {
  return {
    totalCalls: c.totalCalls,
    conversations: c.conversations,
    dmsReached: c.dmsReached,
    connected: c.connected,
    connectRate:
      c.totalCalls - c.aiError <= 0
        ? 0
        : c.connected / (c.totalCalls - c.aiError),
    goalMet: c.goalMet,
    goalMetWithDm: c.goalMetWithDm,
    goalMetRate: c.conversations === 0 ? 0 : c.goalMet / c.conversations,
    avgDurationSeconds:
      c.durationCount === 0 ? 0 : c.durationSum / c.durationCount,
    avgCostPerCall: c.totalCalls === 0 ? 0 : c.spend / c.totalCalls,
    costPerGoalMet: c.goalMet === 0 ? 0 : c.spend / c.goalMet,
    callbacksScheduled: c.callbacksScheduled,
    dncAdditions: c.dncAdditions,
    totalSpend: c.spend,
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
    { label: FUNNEL_LABELS[0], count: called.size },
    { label: FUNNEL_LABELS[1], count: connected.size },
    { label: FUNNEL_LABELS[2], count: conversations.size },
    { label: FUNNEL_LABELS[3], count: dms.size },
  ];
}

/** Stage names, in order. Shared by the row-based funnel and the SQL-backed
 *  one so the two can never label the same chain differently. */
export const FUNNEL_LABELS = [
  "Called",
  "Connected",
  "Conversations",
  "Decision-makers reached",
] as const;

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

/** Below this many cases in the denominator, a step-over-step rate is noise
 *  and must not be reported as a bottleneck. Without it the worst "leak" on a
 *  young funnel is always the last step, where four attendees have produced no
 *  sale yet — an unripe window, not a leak. */
export const MIN_LEAK_SAMPLE = 10;

/** Below this fractional drop, the leak sentence would render as "losing 0%"
 *  — it formats with `.toFixed(0)` — so treat it as no leak worth naming. */
export const MIN_MEANINGFUL_DROP = 0.005;

export type DropCandidate = {
  from: string;
  to: string;
  /** Share KEPT from `from` to `to`, 0..1. Null when it cannot be computed. */
  kept: number | null;
  /** How many cases the rate was computed over. */
  sample: number;
};

/**
 * The worst bottleneck in a chain: the step that keeps the least.
 *
 * Callers pass rates rather than counts on purpose. A funnel step is not
 * always measured against its predecessor's count — the economics panel
 * measures Attended against settled (what `cohorts/math.ts` calls reconciled)
 * registrations, because the ones whose session has not happened yet are not
 * misses. Re-deriving the rate here from counts would silently undo that.
 *
 * `sample` must be the denominator `kept` was divided by — it is NOT always
 * the previous step's count. Passing the previous step's count out of habit,
 * e.g. `worstDrop([{ from: "Registered", to: "Attended", kept: 4 / 8, sample:
 * 500 }])`, declares a rate computed over 8 cases as 500 — sailing straight
 * past the sample floor below.
 *
 * Null when no step drops meaningfully, so a healthy funnel gets no callout.
 */
export function worstDrop(
  candidates: readonly DropCandidate[],
): { from: string; to: string; kept: number; drop: number } | null {
  let worst: { from: string; to: string; kept: number; drop: number } | null =
    null;
  for (const c of candidates) {
    if (c.kept === null || !Number.isFinite(c.kept)) continue;
    if (c.sample < MIN_LEAK_SAMPLE) continue;
    const drop = 1 - c.kept;
    if (drop <= MIN_MEANINGFUL_DROP) continue;
    if (worst === null || drop > worst.drop) {
      worst = { from: c.from, to: c.to, kept: c.kept, drop };
    }
  }
  return worst;
}

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
  const { kpis, prior, ranking } = opts;

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

  // Detail — the all-in cost per appointment when we have bookings.
  const parts: string[] = [];
  // No drop-off sentence here. The funnel panel names the bottleneck, from a
  // chain that runs four steps further and measures Attended against settled
  // registrations rather than against all of them. Two answers to one question
  // on one screen is worse than one, and these two disagreed.
  if (kpis.goalMet > 0 && kpis.costPerGoalMet > 0) {
    parts.push(
      `Each goal met costs $${kpis.costPerGoalMet.toFixed(2)} all-in.`,
    );
  }

  return { headline, detail: parts.length > 0 ? parts.join(" ") : null, tone };
}

// ---------------------------------------------------------------------------
// The SQL-backed path
//
// Everything above aggregates CallRow[] in JavaScript. That is still the
// reference implementation and still what the unit tests exercise, but it is
// no longer how the page gets its numbers: /analytics used to page ~8k calls
// out of the database twice per load (window + comparison period) to count
// them in a for-loop. `analytics_summary` does the counting where the rows
// already are, in one round trip (20260906080000/081000).
//
// Parity between the two paths was verified against production over three
// windows -- the default 30 days, a single busy day, and an empty range --
// every counter, the outcome distribution, the per-day series, the
// per-campaign ranking and the folded funnel, all identical.
// ---------------------------------------------------------------------------

/** One row per Eastern calendar day that actually had calls. Days with none
 *  are absent; the page pre-seeds the full grid so charts have no gaps. */
export type SummaryDay = {
  day: string;
  calls: number;
  spend: number;
  goalLeads: number;
};

export type SummaryCampaign = {
  campaignId: string;
  goalMet: number;
  spend: number;
};

/** The shape `analytics_summary` returns. Mirrors the SQL exactly. */
export type AnalyticsSummary = {
  totals: {
    total_calls: number;
    connected: number;
    ai_error: number;
    conversations: number;
    dms_reached: number;
    callbacks: number;
    dnc_additions: number;
    duration_sum: number | string;
    duration_count: number;
    spend: number | string;
    lead_goal: number;
    lead_goal_dm: number;
    /** ALREADY FOLDED in SQL — see 20260906081000. |A ∪ B| cannot be
     *  recovered from |A| and |B|, so the fold cannot happen out here. */
    funnel_called: number;
    funnel_connected: number;
    funnel_conversation: number;
    funnel_dm: number;
  };
  outcomes: OutcomeBucket[];
  byDay: SummaryDay[];
  byCampaign: SummaryCampaign[];
};

/** Postgres `numeric` arrives over PostgREST as a STRING, not a number —
 *  it is arbitrary-precision and JSON has no such type. Summing or formatting
 *  it without this coercion silently concatenates instead of adding. */
function num(value: number | string | null | undefined): number {
  const n = typeof value === "string" ? Number(value) : (value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Fetch the whole page's aggregate in one round trip.
 *
 *  The window arrives as Eastern day strings and is converted here with the
 *  same helpers the old paged read used, so "the start of an Eastern day" has
 *  one definition rather than one per language. */
export async function fetchAnalyticsSummary(
  supabase: SupabaseClient,
  slicers: Slicers,
): Promise<AnalyticsSummary> {
  const { data, error } = await supabase.rpc("analytics_summary", {
    p_start: startOfDay(slicers.from),
    p_end: endOfDay(slicers.to),
    p_campaign: slicers.campaignId ?? null,
    p_owner: slicers.ownerId ?? null,
    p_list: slicers.listId ?? null,
  });
  // Fail loud. The old code returned [] on a failed page, which rendered a
  // confident, fully-populated Analytics page reading zero everywhere.
  if (error) {
    throw new Error(`Analytics summary failed: ${error.message}`);
  }
  return data as unknown as AnalyticsSummary;
}

/** KPIs from the SQL aggregate. Shares deriveKpis with the row-based path, so
 *  the ratios and their divide-by-zero rules are computed in one place. */
export function kpisFromSummary(summary: AnalyticsSummary): Kpis {
  const t = summary.totals;
  return deriveKpis({
    totalCalls: t.total_calls,
    connected: t.connected,
    aiError: t.ai_error,
    conversations: t.conversations,
    dmsReached: t.dms_reached,
    goalMet: t.lead_goal,
    goalMetWithDm: t.lead_goal_dm,
    durationSum: num(t.duration_sum),
    durationCount: t.duration_count,
    spend: num(t.spend),
    callbacksScheduled: t.callbacks,
    dncAdditions: t.dnc_additions,
  });
}

/** The funnel from the SQL aggregate. Already folded there, so this only
 *  attaches the labels — no second fold, which would be a second chance to
 *  disagree with the first. */
export function funnelFromSummary(summary: AnalyticsSummary): FunnelStep[] {
  const t = summary.totals;
  return [
    { label: FUNNEL_LABELS[0], count: t.funnel_called },
    { label: FUNNEL_LABELS[1], count: t.funnel_connected },
    { label: FUNNEL_LABELS[2], count: t.funnel_conversation },
    { label: FUNNEL_LABELS[3], count: t.funnel_dm },
  ];
}

/** Every Eastern day in the range, in order, with days that had no calls
 *  filled in as zeroes — the chart must not have gaps, and SQL only returns
 *  days that exist. Same pre-seeding the row-based callsByDay did. */
function seedDays(slicers: Slicers): string[] {
  const days: string[] = [];
  const start = new Date(`${slicers.from}T00:00:00Z`);
  const end = new Date(`${slicers.to}T00:00:00Z`);
  for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

export function callsByDayFromSummary(
  summary: AnalyticsSummary,
  slicers: Slicers,
): TimeBucket[] {
  const found = new Map(summary.byDay.map((d) => [d.day, d]));
  return seedDays(slicers).map((day) => {
    const hit = found.get(day);
    return { day, count: hit?.calls ?? 0, spend: num(hit?.spend) };
  });
}

export function bookingsByDayFromSummary(
  summary: AnalyticsSummary,
  slicers: Slicers,
): number[] {
  const found = new Map(summary.byDay.map((d) => [d.day, d]));
  return seedDays(slicers).map((day) => found.get(day)?.goalLeads ?? 0);
}

/** Campaign ranking from the SQL aggregate. Names are resolved out here
 *  because the page already loads them for the filter dropdown. */
export function rankCampaignsFromSummary(
  summary: AnalyticsSummary,
  names: Map<string, string>,
): CampaignRank[] {
  return summary.byCampaign.map((c) => {
    const spend = num(c.spend);
    return {
      campaignId: c.campaignId,
      campaignName: names.get(c.campaignId) ?? "—",
      goalMet: c.goalMet,
      spend,
      costPerGoalMet: c.goalMet === 0 ? 0 : spend / c.goalMet,
    };
  });
}
