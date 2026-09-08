/** The Reporting hub's daily table: one row per dial day, joining what we did
 *  that day to what that day produced. Pure -- no fetches, no `server-only` --
 *  so every rule about what a number MEANS can be tested directly, in the same
 *  spirit as cohorts/math.ts and analytics/list-economics.ts. */

import { costPer } from "@/lib/cohorts/math";

import type { DailyKpi } from "./stats";

/**
 * From `reporting_daily_kpis` (migration 20260907090000) -- the source of truth
 * for everything that HAPPENED on a day.
 *
 * Aliased to `DailyKpi` rather than restated, so this module cannot drift from
 * the shape its caller actually fetches.
 *
 * Note what is NOT in here: spend. The RPC returns counts only; a day's money
 * lives in `cost_rollup_daily` and reaches this page through `cohort_rows`.
 */
export type ActivityDay = DailyKpi;

/**
 * From `cohort_rows` (migration 20260905130000), mirroring `CohortRow` in
 * cohorts/data.ts. Restated structurally because that module is `server-only`
 * and this one must stay importable from anywhere -- the same reason
 * cohorts/math.ts declares its own `RateInput`. The test asserts the two stay
 * assignable, so a change to the RPC breaks type-checking rather than silently
 * joining against a stale shape.
 *
 * It ALSO returns calls / connected / dms, which `reporting_daily_kpis` returns
 * too. Those three are deliberately ignored below: one source per quantity, or
 * the two halves of a row can disagree on screen with nothing saying which is
 * right. `spend` is the exception, and only because it has no second source.
 */
export type CohortDay = {
  dial_day: string;
  calls: number;
  connected: number;
  dms: number;
  regs: number;
  attended: number;
  no_show: number;
  rescheduled: number;
  sales: number;
  spend: number;
  pending: number;
  last_session: string | null;
};

export type OutcomeBreakdown = {
  notInterested: number;
  gatekeeper: number;
  gatekeeperDeclined: number;
  hungUp: number;
  hungUpLater: number;
  aiError: number;
  dnc: number;
  callbacks: number;
  /** 0..1. Never null: `warmPctOf` reports an empty day as 0, and inventing a
   *  null here would make every caller handle a case nothing produces. */
  warmPct: number;
};

export type DailyRow = {
  day: string;
  calls: number;
  connected: number;
  conversations: number;
  dms: number;
  goals: number;
  /** Null -- an em dash -- when the day has no cohort row, exactly like the
   *  outcomes below. Zero would assert we spent nothing that day. */
  spend: number | null;
  /** Null -- an em dash -- when the day has no cohort row at all. "Nobody
   *  booked" and "we have no row for that day" are different claims, and zero
   *  asserts the first. */
  regs: number | null;
  attended: number | null;
  noShow: number | null;
  rescheduled: number | null;
  sales: number | null;
  pending: number | null;
  lastSession: string | null;
  costPerReg: number | null;
  costPerAttended: number | null;
  /** Folded behind a hover on Calls -- nine columns that were competing for
   *  width and that nobody sorted by. The CSV still exports every field. */
  breakdown: OutcomeBreakdown;
};

/**
 * Join a window's activity to its cohort outcomes, newest first.
 *
 * Driven from the ACTIVITY side. A cohort day with no matching activity day is
 * dropped rather than rendered: a registration whose dial day has no calls
 * cannot be shown on a table built from calls, and inventing a row for it would
 * put a day on screen that never happened.
 *
 * Sorts rather than trusting the input order. Both RPCs return newest first
 * today, but this module's contract is the ordering, not theirs.
 */
export function buildDailyRows(
  activity: readonly ActivityDay[],
  cohorts: readonly CohortDay[],
): readonly DailyRow[] {
  const byDay = new Map(cohorts.map((c) => [c.dial_day, c]));

  return [...activity]
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
    .map((a) => {
      const c = byDay.get(a.day) ?? null;
      // Read from `a`, never from `c`, for the four quantities both sources
      // carry -- see the note on CohortDay.
      return {
        day: a.day,
        calls: a.callsMade,
        connected: a.connected,
        conversations: a.convGt1min,
        dms: a.dms,
        goals: a.goals,
        spend: c?.spend ?? null,
        regs: c?.regs ?? null,
        attended: c?.attended ?? null,
        noShow: c?.no_show ?? null,
        rescheduled: c?.rescheduled ?? null,
        sales: c?.sales ?? null,
        pending: c?.pending ?? null,
        lastSession: c?.last_session ?? null,
        // costPer() returns null for a zero spend OR a zero denominator, so an
        // unripe day prints an em dash instead of Infinity.
        costPerReg: c ? costPer(c.spend, c.regs) : null,
        costPerAttended: c ? costPer(c.spend, c.attended) : null,
        breakdown: {
          notInterested: a.notInterested,
          gatekeeper: a.gatekeeper,
          gatekeeperDeclined: a.gatekeeperDeclined,
          hungUp: a.hungUp,
          hungUpLater: a.hungUpLater,
          aiError: a.aiError,
          dnc: a.dnc,
          callbacks: a.callbacks,
          warmPct: a.warmPct,
        },
      };
    });
}
