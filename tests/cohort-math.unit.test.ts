import { describe, expect, it } from "vitest";

import {
  costPer,
  isRipe,
  MIN_CLOSE_SAMPLE,
  MIN_SHOW_SAMPLE,
  projectedCostPerSale,
  rollingRates,
  SALES_WINDOW_DAYS,
} from "../src/lib/cohorts/math";

const NOW = new Date("2026-09-20T12:00:00Z");

describe("costPer", () => {
  it("divides spend by outcomes", () => {
    // 9/2 really did earn 2 attendees for $231.42.
    expect(costPer(231.42, 2)).toBeCloseTo(115.71, 2);
  });

  it("returns null rather than Infinity when there are no outcomes", () => {
    // A day with real spend and zero attendees is the NORMAL state of an
    // unripe cohort. It must render as "—", never as an alarming number.
    expect(costPer(231.42, 0)).toBeNull();
  });

  it("returns null when there was no spend to divide", () => {
    expect(costPer(0, 3)).toBeNull();
  });

  it("returns null for a negative or non-finite spend", () => {
    expect(costPer(-5, 3)).toBeNull();
    expect(costPer(Number.NaN, 3)).toBeNull();
  });
});

describe("isRipe", () => {
  it("is ripe once the last session is more than the sales window past", () => {
    expect(isRipe("2026-09-10T18:00:00Z", 0, NOW)).toBe(true);
  });

  it("is not ripe while a session is inside the sales window", () => {
    expect(isRipe("2026-09-18T18:00:00Z", 0, NOW)).toBe(false);
  });

  it("is not ripe while any registration is still pending", () => {
    // Even a long-past last session cannot settle a day that still has
    // someone unaccounted for.
    expect(isRipe("2026-09-10T18:00:00Z", 3, NOW)).toBe(false);
  });

  it("is not ripe for a day that produced no registrations at all", () => {
    expect(isRipe(null, 0, NOW)).toBe(false);
  });

  it("is not ripe for an unparseable session date", () => {
    expect(isRipe("not a date", 0, NOW)).toBe(false);
  });

  it("uses the documented sales window", () => {
    expect(SALES_WINDOW_DAYS).toBe(7);
  });
});

describe("rollingRates", () => {
  it("computes show and close rates from reconciled registrations", () => {
    const r = rollingRates([
      { attended: 6, no_show: 6, sales: 3 },
      { attended: 6, no_show: 6, sales: 3 },
    ]);
    expect(r.showRate).toBeCloseTo(0.5, 5);
    expect(r.closeRate).toBeCloseTo(0.5, 5);
  });

  it("excludes pending registrations from the show-rate denominator", () => {
    // Someone whose session has not happened must not drag the rate down —
    // the denominator is attended + no_show only.
    const r = rollingRates([{ attended: 10, no_show: 0, sales: 5 }]);
    expect(r.showRate).toBe(1);
  });

  it("suppresses the show rate below the minimum sample", () => {
    const r = rollingRates([{ attended: 2, no_show: 1, sales: 1 }]);
    expect(r.showRate).toBeNull();
  });

  it("suppresses the close rate below the minimum attendee sample", () => {
    const r = rollingRates([{ attended: 4, no_show: 8, sales: 2 }]);
    expect(r.showRate).not.toBeNull();
    expect(r.closeRate).toBeNull();
  });

  it("handles a period with no data without dividing by zero", () => {
    const r = rollingRates([]);
    expect(r.showRate).toBeNull();
    expect(r.closeRate).toBeNull();
  });

  it("reports a genuine zero close rate once the sample is big enough", () => {
    // Distinct from "not enough data": 10 attendees and no sales is a real,
    // reportable 0%.
    const r = rollingRates([{ attended: 10, no_show: 10, sales: 0 }]);
    expect(r.closeRate).toBe(0);
  });
});

describe("projectedCostPerSale", () => {
  it("divides cost per registration by the two conversion rates", () => {
    expect(projectedCostPerSale(37, 0.5, 0.2)).toBeCloseTo(370, 5);
  });

  it("returns null when either rate is unknown", () => {
    expect(projectedCostPerSale(37, null, 0.2)).toBeNull();
    expect(projectedCostPerSale(37, 0.5, null)).toBeNull();
  });

  it("returns null when a rate is zero, rather than Infinity", () => {
    // A real 0% close rate means "no projection is possible", not "$Infinity".
    expect(projectedCostPerSale(37, 0.5, 0)).toBeNull();
  });

  it("returns null without a cost per registration", () => {
    expect(projectedCostPerSale(null, 0.5, 0.2)).toBeNull();
  });
});

describe("sample thresholds", () => {
  it("are the documented values", () => {
    expect(MIN_SHOW_SAMPLE).toBe(10);
    expect(MIN_CLOSE_SAMPLE).toBe(5);
  });
});
