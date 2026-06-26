// KPI math for the Agent Analytics (Market Research) page. Computed in TS,
// reusing the app-wide CONNECTED_OUTCOMES so this page can never disagree with
// the Analytics page. Grouped per ET calendar day.

import { CONNECTED_OUTCOMES } from "@/lib/calls/outcomes";

import { isWarm } from "./field-detect";

export type AgentCallRow = {
  started_at: string | null;
  outcome: string | null;
  duration_seconds: number | null;
  extracted_data: unknown;
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
  return (
    String(ex(r).decision_maker_reached ?? "")
      .trim()
      .toLowerCase() === "yes"
  );
}

export type DailyKpi = {
  day: string;
  callsMade: number;
  connected: number;
  convGt1min: number;
  dms: number;
  callbacks: number;
  callbackLater: number;
  goals: number;
  notInterested: number;
  gatekeeper: number;
  hungUp: number;
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
    callbackLater: 0,
    goals: 0,
    notInterested: 0,
    gatekeeper: 0,
    hungUp: 0,
    aiError: 0,
    dnc: 0,
    sentimentCounts: {},
    warmPct: 0,
  };
}

/** Group calls into per-ET-day KPI rows, newest day first. When `sentimentKey`
 *  is given, also bucket each call's extracted_data[sentimentKey] value and
 *  compute warmPct via the sentiment lexicon. */
export function computeDailyKpis(
  rows: AgentCallRow[],
  sentimentKey?: string | null,
): DailyKpi[] {
  const byDay = new Map<string, DailyKpi>();
  for (const r of rows) {
    if (!r.started_at) continue;
    const day = etDay(r.started_at);
    let k = byDay.get(day);
    if (!k) {
      k = emptyDay(day);
      byDay.set(day, k);
    }
    k.callsMade++;
    const o = r.outcome ?? "";
    if (CONNECTED_OUTCOMES.has(o)) k.connected++;
    if ((r.duration_seconds ?? 0) > 60) k.convGt1min++;
    if (dmReached(r)) k.dms++;
    if (o === "callback") k.callbacks++;
    if (o === "call_back_later") k.callbackLater++;
    if (o === "goal_met") k.goals++;
    if (o === "not_interested") k.notInterested++;
    if (o === "gatekeeper") k.gatekeeper++;
    if (o === "hung_up_immediately") k.hungUp++;
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
    const entries = Object.entries(k.sentimentCounts);
    const total = entries.reduce((s, [, n]) => s + n, 0);
    const warm = entries.reduce((s, [v, n]) => s + (isWarm(v) ? n : 0), 0);
    k.warmPct = total === 0 ? 0 : warm / total;
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}

/** ISO timestamp `days` ago — the lower bound for the history window. Lives
 *  here (not in the component) so the page's render stays pure. */
export function sinceDaysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
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
