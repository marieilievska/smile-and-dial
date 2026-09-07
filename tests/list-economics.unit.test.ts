import { describe, it, expect } from "vitest";

import { MIN_LEAK_SAMPLE } from "@/lib/analytics/stats";
import { MIN_SHOW_SAMPLE } from "@/lib/cohorts/math";
import {
  buildEconomicsFunnel,
  costPerAttended,
  daysLeft,
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

  it("clamps even when settledCount's own clamp has already fired", () => {
    // 25 attended against 20 registrations: the "marked attended, then
    // cancelled" case the migration documents, at a size where it bites.
    // settledCount clamps the denominator to 20 and then STOPS -- 25/20 is
    // 1.25 and it is showRate's own Math.min that has to catch it. The 19/4/20
    // case above cannot see this: there settledCount's clamp alone lands the
    // result on 0.95 and the second clamp never engages, so removing it breaks
    // nothing. This is the case that fails without it.
    expect(showRate({ ...LIVE, attended: 25, no_show: 0, regs: 20 })).toBe(1);
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

describe("costPerAttended", () => {
  it("is the whole composition, spend to attendee", () => {
    // $747.98 over 20 registrations is $37.40; 4 of 8 settled is a 50% show
    // rate; so an attendee projects to $74.80. Verified against production
    // on 2026-09-07.
    expect(costPerAttended(LIVE)).toBeCloseTo(74.8, 2);
  });

  it("is exactly what the funnel's Attended step prices", () => {
    // One definition, three callers. If these two ever diverge, the table and
    // the panel above it are quoting different prices for the same attendee.
    const attended = buildEconomicsFunnel(LIVE).find(
      (s) => s.label === "Attended",
    );
    expect(costPerAttended(LIVE)).toBe(attended?.costEach);
  });

  it("is null for spend nothing has landed against", () => {
    // costPer refuses a zero SPEND, not just a zero denominator: no cost rows
    // does not mean the calls were free. The unattributed row is exactly this.
    expect(costPerAttended({ ...LIVE, spend: 0 })).toBeNull();
  });

  it("is null while nothing has settled, rather than free or infinite", () => {
    expect(
      costPerAttended({ ...LIVE, attended: 0, no_show: 0, pending: 20 }),
    ).toBeNull();
  });

  it("is null for a list with no registrations at all", () => {
    // The Inbound list today: real spend, nothing booked off it.
    expect(
      costPerAttended({
        ...LIVE,
        regs: 0,
        attended: 0,
        no_show: 0,
        pending: 0,
        spend: 1.99,
      }),
    ).toBeNull();
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
});

describe("daysLeft", () => {
  // The UNFILTERED first outbound dial -- `first_dial`, never `first_call`.
  // Feeding this argument the filtered column makes the whole column a
  // property of the date pills: with Today selected the age collapses to a few
  // hours and 56 days renders as 11.
  const FIRST_DIAL = "2026-09-02T12:32:55Z";
  const NOW = new Date("2026-09-07T12:00:00Z");

  it("divides what is left by the recent pace", () => {
    // Dialling began five days ago, so pace is ~1,500 a day and the 83,575
    // remaining is about 56 days.
    expect(daysLeft(LIVE, FIRST_DIAL, NOW)).toBe(56);
  });

  it("uses a full week once the list is older than one", () => {
    const old = new Date("2026-09-20T12:00:00Z");
    // 7,476/7 = 1,068 a day; 83,575 / 1,068 = 78.25, rounded up to 79. The
    // contrast with the 56 above is the whole point of the min(7, age) guard:
    // dividing a five-day total by a flat seven understates pace by 29%.
    expect(daysLeft(LIVE, FIRST_DIAL, old)).toBe(79);
  });

  it("never divides by less than a day, however new the list", () => {
    // Twelve hours old. Without the max(1, ...) floor, paceDays is 0.5 and a
    // full week's 7,476 dials is claimed as 14,952 a day -- a pace this list
    // has never sustained -- which reads 6 days left instead of 12.
    const halfADay = daysLeft(
      LIVE,
      "2026-09-07T00:00:00Z",
      new Date("2026-09-07T12:00:00Z"),
    );
    expect(halfADay).toBe(12);
  });

  it("is null rather than Infinity when nothing has been dialled this week", () => {
    // The Inbound list: 46 calls, all inbound, so worked_7d is 0 and pace is
    // undefined. An em dash, never a number.
    expect(daysLeft({ ...LIVE, worked_7d: 0 }, FIRST_DIAL, NOW)).toBeNull();
  });

  it("is null for a list that has never been called", () => {
    expect(daysLeft(LIVE, null, NOW)).toBeNull();
  });

  it("is null for an unparseable first call", () => {
    expect(daysLeft(LIVE, "not a date", NOW)).toBeNull();
  });

  it("is zero when there is nothing left", () => {
    expect(daysLeft({ ...LIVE, remaining: 0 }, FIRST_DIAL, NOW)).toBe(0);
  });

  it("steps at most once a day rather than creeping hour by hour", () => {
    // Dividing by a continuously growing age made this drift upward all day
    // with nothing having changed — 51 at midnight, 61 by the evening. A
    // number that moves while you watch it stops being believed.
    //
    // Quantising the age to whole days cannot remove the step entirely, and
    // should not: a day passing IS a real change, and a paused dialler really
    // does lengthen how long a list will take. What it removes is the creep.
    const hourly = Array.from({ length: 24 }, (_, h) =>
      daysLeft(
        LIVE,
        FIRST_DIAL,
        new Date(`2026-09-07T${String(h).padStart(2, "0")}:00:00Z`),
      ),
    );

    expect(new Set(hourly).size).toBeLessThanOrEqual(2);
    // And the value the rest of this block asserts is the one it settles on.
    expect(hourly[12]).toBe(56);
    expect(hourly[23]).toBe(56);
  });

  it("rounds a nearly-finished list up to 1, never down into that zero", () => {
    // 300 leads at ~1,500 a day is a fifth of a day. Rounding to nearest hands
    // it the same 0 the line above reserves for an EMPTY list, so "a few hours
    // of dialling left" and "finished" render identically -- at exactly the
    // moment somebody is watching the column to decide whether to buy more
    // leads.
    expect(daysLeft({ ...LIVE, remaining: 300 }, FIRST_DIAL, NOW)).toBe(1);
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

  it("says how thin the attendance sample is, in numbers not prose", () => {
    // Two counts, no wording: the view decides how to say it. They are also
    // NOT a breakdown of the 20 registrations -- scheduled_at is nullable and
    // such a row lands in neither bucket -- so nothing here invites the reader
    // to add them up.
    expect(steps[5].sample).toBe(8);
    expect(steps[5].pending).toBe(12);
    expect(steps[5].confidence).toBe("low");
  });

  it("leaves pending null where the idea means nothing", () => {
    expect(steps.filter((s) => s.pending !== null).map((s) => s.label)).toEqual(
      ["Attended"],
    );
  });

  it("prices a step with no outcomes as null, never Infinity", () => {
    // The zero-DENOMINATOR path, not the zero-spend one: LIVE carries $747.98
    // of real spend, so costPer clears its spend guard and it is `sales` being
    // 0 that returns null. Do not swap LIVE for a zero-spend fixture here or
    // the assertion stops testing what its name claims.
    expect(LIVE.spend).toBeGreaterThan(0);
    expect(LIVE.sales).toBe(0);
    expect(steps[6].costEach).toBeNull();
  });

  it("never lets Sold be named as the bottleneck", () => {
    // A sale ripens over the sales window after the session, and nothing here
    // knows how many of these attendees are still inside it. `kept` is 0/4
    // today, so drop is 1.0 -- the maximum a funnel can produce. The moment
    // attendance crosses the leak sample floor with sales still ripening, Sold
    // would beat every genuine leak on the page and headline "losing 100%
    // between Attended and Sold".
    expect(steps[6].label).toBe("Sold");
    expect(steps[6].leakEligible).toBe(false);
  });

  it("lets every other step be named", () => {
    expect(steps.filter((s) => !s.leakEligible).map((s) => s.label)).toEqual([
      "Sold",
    ]);
  });

  it("keeps Sold ineligible once its sample clears the leak floor", () => {
    // The motivating case, pinned: twelve attendees, nobody has bought yet.
    // The sample floor is no longer doing the work, so only leakEligible is
    // standing between the panel and a meaningless headline.
    const ripening = buildEconomicsFunnel({
      ...LIVE,
      regs: 12,
      attended: 12,
      no_show: 0,
      pending: 0,
      sales: 0,
    });
    const sold = ripening[6];
    expect(sold.label).toBe("Sold");
    expect(sold.sample).toBeGreaterThanOrEqual(MIN_LEAK_SAMPLE);
    expect(sold.kept).toBe(0);
    expect(sold.leakEligible).toBe(false);
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
