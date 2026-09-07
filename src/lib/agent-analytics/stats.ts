// KPI math for the Agent Analytics (Market Research) page. Computed in TS,
// reusing the app-wide CONNECTED_OUTCOMES so this page can never disagree with
// the Analytics page. Grouped per ET calendar day.

import { callReachedDm } from "@/lib/calls/decision-maker";
import { CONNECTED_OUTCOMES } from "@/lib/calls/outcomes";
import { etDateDaysAgo, etMidnightUtcIso } from "@/lib/time/eastern";

import { isWarm } from "./field-detect";

export type AgentCallRow = {
  /** Bucketed by created_at (not started_at) — the same column every other
   *  "calls" number in the app counts on. */
  created_at: string | null;
  outcome: string | null;
  duration_seconds: number | null;
  extracted_data: unknown;
  /** Used to count goals per BUSINESS (distinct lead) rather than per call. */
  lead_id: string | null;
};

const TZ = "America/New_York";

/** The call's ET calendar date (YYYY-MM-DD) — an overnight run that crosses
 *  midnight UTC still lands on one Eastern day. */
export function etDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(
    new Date(iso),
  );
}

function ex(r: AgentCallRow): Record<string, unknown> {
  return r.extracted_data && typeof r.extracted_data === "object"
    ? (r.extracted_data as Record<string, unknown>)
    : {};
}
export function dmReached(r: AgentCallRow): boolean {
  // Outcome-aware: a gatekeeper the AI mis-flagged as DM must not count (see
  // callReachedDm / OUTCOME_EXCLUDES_DM). Keeps this per-call DM count honest.
  return callReachedDm(ex(r), r.outcome);
}

export type DailyKpi = {
  day: string;
  callsMade: number;
  connected: number;
  convGt1min: number;
  dms: number;
  callbacks: number;
  goals: number;
  notInterested: number;
  gatekeeper: number;
  gatekeeperDeclined: number;
  hungUp: number;
  hungUpLater: number;
  aiError: number;
  dnc: number;
  /** Per-day counts keyed by the campaign's lowercased sentiment value
   *  (e.g. { yes: 3, maybe: 1, no: 2 }). Empty when no sentiment field. */
  sentimentCounts: Record<string, number>;
  /** (warm answers) / (total answered), 0..1; warm = positive or neutral. */
  warmPct: number;
};

function emptyDay(day: string): DailyKpi {
  return {
    day,
    callsMade: 0,
    connected: 0,
    convGt1min: 0,
    dms: 0,
    callbacks: 0,
    goals: 0,
    notInterested: 0,
    gatekeeper: 0,
    gatekeeperDeclined: 0,
    hungUp: 0,
    hungUpLater: 0,
    aiError: 0,
    dnc: 0,
    sentimentCounts: {},
    warmPct: 0,
  };
}

/** Group calls into per-ET-day KPI rows, newest day first. When `sentimentKey`
 *  is given, also bucket each call's extracted_data[sentimentKey] value and
 *  compute warmPct via the sentiment lexicon.
 *
 *  THE EXECUTABLE SPECIFICATION. This no longer runs in production —
 *  `reporting_daily_kpis` does the counting in SQL now (20260907090000), from
 *  one round trip instead of nine. It is kept, and kept tested, because the
 *  rules it encodes are ones that are easy to get subtly wrong:
 *
 *    * goals are distinct BUSINESSES per day, never goal-met calls (#279)
 *    * a conversation is a CONNECTED call over a minute — duration alone lets
 *      a looping phone menu count as a conversation
 *    * `> 60`, strictly, which is NOT the `>= 60` analytics_summary uses on a
 *      different column
 *    * the DM flag is vetoed by outcomes that definitionally reached nobody,
 *      so a mis-flagged gatekeeper is not counted as a decision-maker
 *
 *  It is what the SQL was translated from and what it is checked against:
 *  `npm run verify:reporting` runs both over seven production windows and
 *  diffs every counter on every day. The paged FETCH that fed it is gone. */
export function computeDailyKpis(
  rows: AgentCallRow[],
  sentimentKey?: string | null,
): DailyKpi[] {
  const byDay = new Map<string, DailyKpi>();
  // Goals are per BUSINESS: distinct leads per day, so a lead with two goal-met
  // calls the same day (or a same-day merge) counts once. Tallied into k.goals
  // after the loop.
  const goalLeadsByDay = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.created_at) continue;
    const day = etDay(r.created_at);
    let k = byDay.get(day);
    if (!k) {
      k = emptyDay(day);
      byDay.set(day, k);
    }
    k.callsMade++;
    const o = r.outcome ?? "";
    const connected = CONNECTED_OUTCOMES.has(o);
    if (connected) k.connected++;
    // Duration alone doesn't make a conversation: a looping phone menu or a long
    // voicemail greeting can easily run past a minute without a person ever
    // speaking (one IVR ran 203s). Requiring a connected outcome also keeps this
    // a strict subset of `connected` — it could previously exceed it.
    if (connected && (r.duration_seconds ?? 0) > 60) k.convGt1min++;
    if (dmReached(r)) k.dms++;
    if (o === "callback") k.callbacks++;
    if (o === "goal_met" && r.lead_id) {
      let s = goalLeadsByDay.get(day);
      if (!s) {
        s = new Set();
        goalLeadsByDay.set(day, s);
      }
      s.add(r.lead_id);
    }
    if (o === "not_interested") k.notInterested++;
    if (o === "gatekeeper") k.gatekeeper++;
    if (o === "gatekeeper_not_interested") k.gatekeeperDeclined++;
    if (o === "hung_up_immediately") k.hungUp++;
    if (o === "hung_up_later") k.hungUpLater++;
    if (o === "ai_error") k.aiError++;
    if (o === "dnc") k.dnc++;
    if (sentimentKey) {
      const ed =
        r.extracted_data && typeof r.extracted_data === "object"
          ? (r.extracted_data as Record<string, unknown>)
          : {};
      const v = String(ed[sentimentKey] ?? "")
        .trim()
        .toLowerCase();
      if (v) k.sentimentCounts[v] = (k.sentimentCounts[v] ?? 0) + 1;
    }
  }
  for (const k of byDay.values()) {
    k.goals = goalLeadsByDay.get(k.day)?.size ?? 0;
    k.warmPct = warmPctOf(k.sentimentCounts);
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}

/** Share of answered calls whose sentiment value is warm (positive or neutral).
 *
 *  The lexicon lives in field-detect.ts and stays in TypeScript on purpose:
 *  `reporting_daily_kpis` counts the raw {value: count} buckets in SQL but
 *  deliberately does NOT decide what "warm" means, so there is one definition
 *  rather than one per language. Both the row-based path and the SQL-backed one
 *  call this. */
export function warmPctOf(counts: Record<string, number>): number {
  const entries = Object.entries(counts);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  const warm = entries.reduce((s, [v, n]) => s + (isWarm(v) ? n : 0), 0);
  return total === 0 ? 0 : warm / total;
}

/** ET midnight `days` ago (ISO) — the lower bound for the history window, so
 *  the oldest day in the report is a whole Eastern day rather than a partial
 *  one cut at "now minus N×24h". Lives here (not in the component) so the
 *  page's render stays pure. */
export function sinceDaysAgoIso(days: number): string {
  return etMidnightUtcIso(etDateDaysAgo(days));
}

/** Yesterday's ET date (YYYY-MM-DD) — the page's default selected day. */
export function yesterdayEt(): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(
    new Date(),
  );
  const [y, m, d] = today.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}
