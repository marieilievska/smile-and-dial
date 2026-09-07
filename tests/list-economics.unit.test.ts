import { describe, it, expect } from "vitest";

import { MIN_SHOW_SAMPLE } from "@/lib/cohorts/math";
import {
  buildEconomicsFunnel,
  daysLeft,
  MIN_PROJECTION_SAMPLE,
  projectedCostPerAttended,
  projectionConfidence,
  settledCount,
  showRate,
  type EconomicsTotals,
} from "@/lib/analytics/list-economics";

/** Production, both lists, all time, 2026-09-07. Every expected value below
 *  was verified against the live RPC before being written down. */
const LIVE: EconomicsTotals = {
  leads: 84032,
  worked: 7518,
  calls: 8156,
  connected: 3436,
  reached: 3194,
  voicemail: 4275,
  dms: 192,
  goals: 20,
  regs: 20,
  attended: 4,
  no_show: 4,
  pending: 12,
  sales: 0,
  spend: 747.98,
  remaining: 83575,
  worked_7d: 7476,
};

describe("settledCount", () => {
  it("is attended plus no-show, never the registration count", () => {
    // The 12 pending are not misses. Counting them would report a 20% show
    // rate where the truth is 50%.
    expect(settledCount(LIVE)).toBe(8);
  });

  it("is zero before anything has settled", () => {
    expect(settledCount({ ...LIVE, attended: 0, no_show: 0 })).toBe(0);
  });

  it("never exceeds the registrations it is a subset of", () => {
    // `attended` carries no `status <> 'canceled'` guard while `regs` does --
    // inherited from cohort_rows and deliberately not diverged from. So
    // "marked attended, later cancelled" can push the raw sum past regs, and
    // an unclamped show rate would render above 100%.
    expect(settledCount({ ...LIVE, attended: 19, no_show: 4, regs: 20 })).toBe(
      20,
    );
  });
});

describe("showRate", () => {
  it("divides attendance by settled registrations", () => {
    expect(showRate(LIVE)).toBeCloseTo(0.5, 4);
  });

  it("is null rather than 0 while nothing has settled", () => {
    // A cohort whose sessions are all still to come has no show rate. Zero
    // would read as "nobody came".
    expect(
      showRate({ ...LIVE, attended: 0, no_show: 0, pending: 20 }),
    ).toBeNull();
  });

  it("never exceeds 1, so the panel cannot render above 100%", () => {
    expect(
      showRate({ ...LIVE, attended: 19, no_show: 4, regs: 20 }),
    ).toBeLessThanOrEqual(1);
  });
});

describe("projectedCostPerAttended", () => {
  it("is cost per registration divided by the show rate", () => {
    // $37.40 / 50% = $74.80 -- steerable today. The naive spend/attended is
    // $187.00, which divides all spend by attendance most of it has not
    // produced yet.
    expect(projectedCostPerAttended(37.4, 0.5)).toBeCloseTo(74.8, 2);
  });

  it("is null when there is no show rate to project through", () => {
    expect(projectedCostPerAttended(37.4, null)).toBeNull();
  });

  it("is null rather than Infinity at a zero show rate", () => {
    expect(projectedCostPerAttended(37.4, 0)).toBeNull();
  });

  it("is null without a cost per registration", () => {
    expect(projectedCostPerAttended(null, 0.5)).toBeNull();
    expect(projectedCostPerAttended(0, 0.5)).toBeNull();
  });

  it("is null for a non-finite input rather than propagating NaN", () => {
    // worstDrop's isFinite guard exists because a NaN rate poisons a whole
    // chain. Do not hand it one from here.
    expect(projectedCostPerAttended(Number.NaN, 0.5)).toBeNull();
    expect(projectedCostPerAttended(37.4, Number.NaN)).toBeNull();
  });
});

describe("projectionConfidence", () => {
  it("hides a projection built on almost nothing", () => {
    expect(projectionConfidence(0)).toBe("hidden");
    expect(projectionConfidence(2)).toBe("hidden");
  });

  it("shows it dimmed below the sample floor", () => {
    // Eight settled today: a real number, but thin enough that it must carry
    // its sample size on screen.
    expect(projectionConfidence(3)).toBe("low");
    expect(projectionConfidence(8)).toBe("low");
    expect(projectionConfidence(MIN_SHOW_SAMPLE - 1)).toBe("low");
  });

  it("shows it plainly at or above the floor", () => {
    expect(projectionConfidence(MIN_SHOW_SAMPLE)).toBe("normal");
    expect(projectionConfidence(500)).toBe("normal");
  });

  it("borrows the floor from cohorts/math rather than redefining it", () => {
    // If ten is ever the wrong floor, both pages must move together.
    expect(MIN_PROJECTION_SAMPLE).toBeLessThan(MIN_SHOW_SAMPLE);
  });
});

describe("daysLeft", () => {
  const FIRST_CALL = "2026-09-02T12:32:55Z";
  const NOW = new Date("2026-09-07T12:00:00Z");

  it("divides what is left by the recent pace", () => {
    // Dialling began five days ago, so pace is ~1,500 a day and the 83,575
    // remaining is about 56 days.
    expect(daysLeft(LIVE, FIRST_CALL, NOW)).toBe(56);
  });

  it("does not divide by a flat seven on a list younger than a week", () => {
    // 7,476/7 would understate pace by 29% and claim 78 days.
    expect(daysLeft(LIVE, FIRST_CALL, NOW)).toBeLessThan(60);
  });

  it("uses a full week once the list is older than one", () => {
    const old = new Date("2026-09-20T12:00:00Z");
    // 7,476/7 = 1,068 a day; 83,575 / 1,068 = 78.
    expect(daysLeft(LIVE, FIRST_CALL, old)).toBe(78);
  });

  it("is null rather than Infinity when nothing has been dialled this week", () => {
    // The Inbound list: 46 calls, all inbound, so worked_7d is 0 and pace is
    // undefined. An em dash, never a number.
    expect(daysLeft({ ...LIVE, worked_7d: 0 }, FIRST_CALL, NOW)).toBeNull();
  });

  it("is null for a list that has never been called", () => {
    expect(daysLeft(LIVE, null, NOW)).toBeNull();
  });

  it("is null for an unparseable first call", () => {
    expect(daysLeft(LIVE, "not a date", NOW)).toBeNull();
  });

  it("is zero when there is nothing left", () => {
    expect(daysLeft({ ...LIVE, remaining: 0 }, FIRST_CALL, NOW)).toBe(0);
  });
});

describe("buildEconomicsFunnel", () => {
  const steps = buildEconomicsFunnel(LIVE);

  it("runs businesses dialled through to sold", () => {
    expect(steps.map((s) => s.label)).toEqual([
      "Businesses dialled",
      "Someone answered",
      "Decision-maker",
      "Goal met",
      "Registered",
      "Attended",
      "Sold",
    ]);
  });

  it("has no rate on the first step, which has nothing above it", () => {
    expect(steps[0].kept).toBeNull();
  });

  it("measures each step against the one above it", () => {
    expect(steps[1].kept).toBeCloseTo(3194 / 7518, 4);
    expect(steps[2].kept).toBeCloseTo(192 / 3194, 4);
    expect(steps[3].kept).toBeCloseTo(20 / 192, 4);
    expect(steps[4].kept).toBeCloseTo(1, 4);
  });

  it("measures Attended against SETTLED, not against registrations", () => {
    // The whole point. 4/8, not 4/20.
    expect(steps[5].kept).toBeCloseTo(0.5, 4);
    expect(steps[5].sample).toBe(8);
  });

  it("prices every step from the same spend", () => {
    expect(steps[0].costEach).toBeCloseTo(0.0995, 3);
    expect(steps[2].costEach).toBeCloseTo(3.896, 2);
    expect(steps[4].costEach).toBeCloseTo(37.4, 2);
  });

  it("projects the cost of an attendee instead of dividing naively", () => {
    expect(steps[5].projected).toBe(true);
    expect(steps[5].costEach).toBeCloseTo(74.8, 1);
  });

  it("says how thin the attendance sample is", () => {
    expect(steps[5].note).toBe("of 8 settled · 12 pending");
    expect(steps[5].confidence).toBe("low");
  });

  it("prices a step with no outcomes as null, never Infinity", () => {
    expect(steps[6].costEach).toBeNull();
  });

  it("never yields a NaN rate, which would poison the leak detector", () => {
    for (const s of steps) {
      expect(s.kept === null || Number.isFinite(s.kept)).toBe(true);
    }
  });

  it("survives a list nothing has been dialled from", () => {
    const empty = buildEconomicsFunnel({
      ...LIVE,
      worked: 0,
      reached: 0,
      dms: 0,
      goals: 0,
      regs: 0,
      attended: 0,
      no_show: 0,
      pending: 0,
      sales: 0,
      spend: 0,
    });
    expect(empty.every((s) => s.costEach === null)).toBe(true);
    expect(empty.slice(1).every((s) => s.kept === null)).toBe(true);
  });
});
