import { describe, expect, it } from "vitest";

import {
  buildDailyRows,
  type ActivityDay,
  type CohortDay,
} from "@/lib/agent-analytics/daily";
import type { CohortRow } from "@/lib/cohorts/data";

/** Deliberately OLDEST FIRST. `reporting_daily_kpis` happens to return newest
 *  first today, so a fixture that arrived pre-sorted would let the module drop
 *  its sort entirely and still pass. */
const ACTIVITY: ActivityDay[] = [
  {
    day: "2026-09-02",
    callsMade: 1500,
    connected: 650,
    convGt1min: 140,
    dms: 35,
    callbacks: 7,
    goals: 4,
    notInterested: 110,
    gatekeeper: 70,
    gatekeeperDeclined: 10,
    hungUp: 55,
    hungUpLater: 25,
    aiError: 1,
    dnc: 3,
    sentimentCounts: { positive: 28, negative: 72 },
    warmPct: 0.28,
  },
  {
    day: "2026-09-03",
    callsMade: 1600,
    connected: 700,
    convGt1min: 150,
    dms: 40,
    callbacks: 9,
    goals: 5,
    notInterested: 120,
    gatekeeper: 80,
    gatekeeperDeclined: 12,
    hungUp: 60,
    hungUpLater: 30,
    aiError: 2,
    dnc: 4,
    sentimentCounts: { positive: 31, negative: 69 },
    warmPct: 0.31,
  },
];

const COHORT: CohortDay[] = [
  {
    dial_day: "2026-09-03",
    // Deliberately DISAGREEING with the activity day's 1600 / 700 / 40. These
    // three are the collision this module exists to resolve; a fixture whose
    // two sources agreed could not tell which one a row was read from.
    calls: 1,
    connected: 2,
    dms: 3,
    regs: 8,
    attended: 3,
    no_show: 2,
    rescheduled: 1,
    sales: 1,
    spend: 147.2,
    pending: 3,
    last_session: "2026-09-05T18:00:00Z",
  },
  // 2026-09-02 deliberately absent: a day that dialled and booked nothing.
];

describe("buildDailyRows", () => {
  const rows = buildDailyRows(ACTIVITY, COHORT);

  it("returns one row per day that had activity, newest first", () => {
    expect(rows.map((r) => r.day)).toEqual(["2026-09-03", "2026-09-02"]);
  });

  it("takes calls, connected and dms from the ACTIVITY source only", () => {
    // Both RPCs return these three. One source per quantity, or the two halves
    // of a row can disagree on screen with nothing saying which is right.
    expect(rows[0].calls).toBe(1600);
    expect(rows[0].connected).toBe(700);
    expect(rows[0].dms).toBe(40);
  });

  it("takes conversations and goals from the ACTIVITY source", () => {
    expect(rows[0].conversations).toBe(150);
    expect(rows[0].goals).toBe(5);
  });

  it("attaches the registration outcomes from the cohort source", () => {
    expect(rows[0].regs).toBe(8);
    expect(rows[0].attended).toBe(3);
    expect(rows[0].noShow).toBe(2);
    expect(rows[0].rescheduled).toBe(1);
    expect(rows[0].sales).toBe(1);
    expect(rows[0].pending).toBe(3);
    expect(rows[0].lastSession).toBe("2026-09-05T18:00:00Z");
  });

  it("leaves outcomes NULL, not zero, on a day with no cohort row", () => {
    // "Nobody booked" and "we have no row for that day" are different claims.
    // Zero would assert the first; null renders an em dash and asserts neither.
    expect(rows[1].regs).toBeNull();
    expect(rows[1].attended).toBeNull();
    expect(rows[1].sales).toBeNull();
    expect(rows[1].noShow).toBeNull();
    expect(rows[1].pending).toBeNull();
    expect(rows[1].lastSession).toBeNull();
  });

  it("reads the day's spend from the cohort row, the only source that has it", () => {
    // `reporting_daily_kpis` returns no spend at all -- `cost_rollup_daily`,
    // reached through cohort_rows, is where a day's money lives.
    expect(rows[0].spend).toBe(147.2);
  });

  it("leaves spend NULL, not zero, on a day with no cohort row", () => {
    // Same claim as the outcomes: zero would assert we spent nothing that day.
    expect(rows[1].spend).toBeNull();
  });

  it("derives cost per registration from the day's spend", () => {
    expect(rows[0].costPerReg).toBeCloseTo(147.2 / 8, 3);
  });

  it("derives cost per attendee from attendance, not from registrations", () => {
    expect(rows[0].costPerAttended).toBeCloseTo(147.2 / 3, 3);
  });

  it("returns null costs rather than Infinity when nothing was produced", () => {
    expect(rows[1].costPerReg).toBeNull();
    expect(rows[1].costPerAttended).toBeNull();
  });

  it("returns null costs on a cohort row that booked nothing", () => {
    // costPer()'s zero-denominator guard, exercised through this module: a day
    // with real spend and no registrations is a normal unripe cohort, not an
    // Infinity to print.
    const barren = buildDailyRows(ACTIVITY, [
      { ...COHORT[0], regs: 0, attended: 0 },
    ]);
    expect(barren[0].regs).toBe(0);
    expect(barren[0].costPerReg).toBeNull();
    expect(barren[0].costPerAttended).toBeNull();
  });

  it("carries the outcome breakdown for the hover", () => {
    expect(rows[0].breakdown).toEqual({
      notInterested: 120,
      gatekeeper: 80,
      gatekeeperDeclined: 12,
      hungUp: 60,
      hungUpLater: 30,
      aiError: 2,
      dnc: 4,
      callbacks: 9,
      warmPct: 0.31,
    });
  });

  it("is empty for an empty window, without throwing", () => {
    // The database was wiped on 2026-09-08; this is the normal state today.
    expect(buildDailyRows([], [])).toEqual([]);
  });

  it("ignores a cohort day with no matching activity day", () => {
    // A registration whose dial day has no calls cannot be rendered on a table
    // built from activity. Dropping it is right; silently inventing a row is not.
    const odd = buildDailyRows(ACTIVITY, [
      ...COHORT,
      {
        dial_day: "2026-01-01",
        calls: 0,
        connected: 0,
        dms: 0,
        regs: 5,
        attended: 1,
        no_show: 0,
        rescheduled: 0,
        sales: 0,
        spend: 12,
        pending: 4,
        last_session: null,
      },
    ]);
    expect(odd).toHaveLength(2);
    expect(odd.map((r) => r.day)).toEqual(["2026-09-03", "2026-09-02"]);
  });

  it("stays in step with the real cohort_rows row shape", () => {
    // Compile-time guard, erased at runtime: CohortRow (what fetchCohortRows
    // really returns) must stay assignable to CohortDay, so a change to the
    // RPC's shape breaks `tsc` here rather than silently joining a stale one.
    const sample: CohortDay = {} as CohortRow;
    expect(typeof sample).toBe("object");
  });
});
