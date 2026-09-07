/** Pure economics arithmetic for the /analytics list panels. No `server-only`,
 *  no fetches -- every rule that decides what a number MEANS lives here so it
 *  can be tested directly, in the same spirit as cohorts/math.ts and
 *  classify-outcome.ts. */

import { costPer, MIN_SHOW_SAMPLE } from "@/lib/cohorts/math";

import type { ListPerformanceRow } from "./list-performance";

/** Below three settled registrations there is no rate worth printing: one
 *  person attending is not a show rate. Between this and MIN_SHOW_SAMPLE the
 *  projection is shown but visibly de-emphasised and carries its sample size,
 *  because a projection is only dangerous when its sample is invisible. */
export const MIN_PROJECTION_SAMPLE = 3;

/** How much weight the reader should give a projected number. */
export type Confidence = "hidden" | "low" | "normal";

/** Everything the funnel needs. Structurally a `ListPerformanceRow` minus the
 *  identity columns, so both a single row and `totalsFor(...)` satisfy it. */
export type EconomicsTotals = Pick<
  ListPerformanceRow,
  | "leads"
  | "worked"
  | "calls"
  | "connected"
  | "reached"
  | "voicemail"
  | "dms"
  | "goals"
  | "regs"
  | "attended"
  | "no_show"
  | "pending"
  | "sales"
  | "spend"
  | "remaining"
  | "worked_7d"
>;

/**
 * Registrations whose session has actually resolved.
 *
 * The ONLY valid denominator for a show rate. `regs` includes people whose
 * webinar has not happened yet: on 2026-09-07 that was 12 of 20, so
 * `attended / regs` read 20% where the truth was 50%.
 *
 * Clamped to `regs` on purpose. `attended` counts `attended_at is not null`
 * with no cancellation guard, while `regs` excludes cancelled rows -- so a
 * registration marked attended and cancelled afterwards is in one and not the
 * other, and the raw sum can exceed the whole. That asymmetry is inherited
 * from `cohort_rows` and deliberately not diverged from, because the two
 * functions agreeing matters more; the clamp belongs here, in the consumer.
 * Without it the panel renders a show rate above 100%.
 */
export function settledCount(t: EconomicsTotals): number {
  return Math.min(t.attended + t.no_show, t.regs);
}

/** Attendance over settled registrations, or null while nothing has settled --
 *  which must not render as "nobody came". */
export function showRate(t: EconomicsTotals): number | null {
  const settled = settledCount(t);
  if (settled <= 0) return null;
  return Math.min(t.attended / settled, 1);
}

/**
 * What an attendee costs, projected through the show rate.
 *
 * The same move `projectedCostPerSale` makes one step further along, and for
 * the same reason: cost per registration is knowable the same day, cost per
 * attendee is not knowable until the session happens. Dividing spend by
 * attendance instead charges today's money against a session that has not run.
 */
export function projectedCostPerAttended(
  costPerRegistration: number | null,
  rate: number | null,
): number | null {
  if (costPerRegistration === null || !Number.isFinite(costPerRegistration)) {
    return null;
  }
  if (costPerRegistration <= 0) return null;
  if (rate === null || !Number.isFinite(rate) || rate <= 0) return null;
  return costPerRegistration / rate;
}

/**
 * How much to trust a projection built on `settled` cases.
 *
 * `MIN_SHOW_SAMPLE` is imported, never redefined: if ten is ever the wrong
 * floor, /analytics and the Cohorts tab have to move together or they will
 * quietly start disagreeing.
 */
export function projectionConfidence(settled: number): Confidence {
  if (settled < MIN_PROJECTION_SAMPLE) return "hidden";
  if (settled < MIN_SHOW_SAMPLE) return "low";
  return "normal";
}

/**
 * How many days of dialling are left in a list at the recent pace.
 *
 * The `min(7, age)` guard matters. Dialling on this workspace began five days
 * before this was written; dividing a five-day total by a flat seven days
 * understates pace by 29% and turns a true 56 days into a claimed 78. The
 * guard retires itself once a list is more than a week old.
 *
 * Null -- an em dash on screen -- when nothing has been dialled this week, so
 * an idle list never renders as Infinity. The Inbound list is exactly this
 * case: its calls are all inbound, so `worked_7d` is zero.
 */
export function daysLeft(
  t: EconomicsTotals,
  firstCall: string | null,
  now: Date = new Date(),
): number | null {
  if (t.worked_7d <= 0) return null;
  if (t.remaining <= 0) return 0;
  if (!firstCall) return null;
  const started = new Date(firstCall).getTime();
  if (Number.isNaN(started)) return null;
  const ageDays = (now.getTime() - started) / 86_400_000;
  const paceDays = Math.max(1, Math.min(7, ageDays));
  const pace = t.worked_7d / paceDays;
  if (!Number.isFinite(pace) || pace <= 0) return null;
  return Math.round(t.remaining / pace);
}

/** One row of the "Where the money goes" chain. */
export type EconomicsStep = {
  label: string;
  count: number;
  /** Share kept from the step above; null on the first step and wherever the
   *  denominator is zero. */
  kept: number | null;
  /** The denominator `kept` was computed over -- not always the previous
   *  step's count, which is the entire point of the Attended row. */
  sample: number;
  /** Spend per one of these; null when the ratio would be meaningless. */
  costEach: number | null;
  /** True when `costEach` is projected rather than divided. */
  projected: boolean;
  confidence: Confidence;
  /** A second line under the label, or null. */
  note: string | null;
};

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : null;
}

/**
 * The business-level chain, with money attached to every step.
 *
 * Calls and voicemail are deliberately absent: they are CALL-level, and mixing
 * them into a column of business-level percentages would leave two rows whose
 * denominators differ with no way to tell. They belong in the header strip.
 */
export function buildEconomicsFunnel(
  t: EconomicsTotals,
): readonly EconomicsStep[] {
  const plain = (
    label: string,
    count: number,
    prev: number | null,
  ): EconomicsStep => ({
    label,
    count,
    kept: prev === null ? null : rate(count, prev),
    sample: prev ?? 0,
    costEach: costPer(t.spend, count),
    projected: false,
    confidence: "normal",
    note: null,
  });

  const settled = settledCount(t);
  const rateOfShow = showRate(t);
  const costPerReg = costPer(t.spend, t.regs);

  return [
    plain("Businesses dialled", t.worked, null),
    plain("Someone answered", t.reached, t.worked),
    plain("Decision-maker", t.dms, t.reached),
    plain("Goal met", t.goals, t.dms),
    plain("Registered", t.regs, t.goals),
    {
      label: "Attended",
      count: t.attended,
      // Against SETTLED registrations. Anyone whose session has not happened
      // is not a miss, and must not drag the rate down.
      kept: rateOfShow,
      sample: settled,
      costEach: projectedCostPerAttended(costPerReg, rateOfShow),
      projected: true,
      confidence: projectionConfidence(settled),
      note:
        settled > 0 || t.pending > 0
          ? `of ${settled.toLocaleString()} settled · ${t.pending.toLocaleString()} pending`
          : null,
    },
    plain("Sold", t.sales, t.attended),
  ];
}
