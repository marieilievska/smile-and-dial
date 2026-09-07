import { describe, it, expect } from "vitest";

import {
  buildInsights,
  MIN_LEAK_SAMPLE,
  worstDrop,
} from "@/lib/analytics/stats";

describe("worstDrop", () => {
  it("picks the step that keeps the least", () => {
    const worst = worstDrop([
      { from: "Dialled", to: "Answered", kept: 0.425, sample: 7518 },
      { from: "Answered", to: "Decision-maker", kept: 0.06, sample: 3194 },
      { from: "Decision-maker", to: "Goal", kept: 0.104, sample: 192 },
    ]);
    expect(worst?.to).toBe("Decision-maker");
    expect(worst?.kept).toBeCloseTo(0.06, 3);
    expect(worst?.drop).toBeCloseTo(0.94, 3);
  });

  it("keeps the earlier step on a tie rather than the later one", () => {
    // First-wins is the intended semantic: point the operator at the
    // earliest bottleneck in the chain. Flipping the max comparison from `>`
    // to `>=` would return "Connected" -> "Conversations" here instead.
    const worst = worstDrop([
      { from: "Called", to: "Connected", kept: 0.5, sample: 100 },
      { from: "Connected", to: "Conversations", kept: 0.5, sample: 100 },
    ]);
    expect(worst?.from).toBe("Called");
    expect(worst?.to).toBe("Connected");
  });

  it("ignores steps with too small a sample to judge", () => {
    // Attended -> Sold is 0 of 4 today: a 100% "drop" that is really an
    // unripe sales window. Without this guard it would out-rank the real
    // 94% gatekeeper leak and the callout would point at the wrong step.
    const worst = worstDrop([
      { from: "Answered", to: "Decision-maker", kept: 0.06, sample: 3194 },
      { from: "Attended", to: "Sold", kept: 0, sample: 4 },
    ]);
    expect(worst?.to).toBe("Decision-maker");
  });

  it("returns null when nothing meaningfully drops", () => {
    // A step that keeps everything is not a leak.
    expect(
      worstDrop([{ from: "Goal", to: "Registered", kept: 1, sample: 20 }]),
    ).toBeNull();
  });

  it("returns null for an empty chain", () => {
    expect(worstDrop([])).toBeNull();
  });

  it("skips a null rate rather than treating it as a total loss", () => {
    expect(
      worstDrop([
        { from: "Attended", to: "Sold", kept: null, sample: 4000 },
        { from: "Answered", to: "Decision-maker", kept: 0.06, sample: 3194 },
      ])?.to,
    ).toBe("Decision-maker");
  });

  it("skips a NaN rate rather than treating it as the first candidate", () => {
    // Without the isFinite guard, `NaN <= 0.005` is false, so NaN would be
    // adopted as `worst` outright -- and every later `drop > NaN` comparison
    // is also false, permanently suppressing the real leak. The bad
    // candidate goes first so this exercises that exact failure mode, not
    // just "NaN is somewhere in the list."
    expect(
      worstDrop([
        { from: "Bad", to: "Data", kept: NaN, sample: 4000 },
        { from: "Answered", to: "Decision-maker", kept: 0.06, sample: 3194 },
      ])?.to,
    ).toBe("Decision-maker");
  });

  it("skips an infinite rate rather than treating it as the first candidate", () => {
    expect(
      worstDrop([
        { from: "Bad", to: "Data", kept: Infinity, sample: 4000 },
        { from: "Answered", to: "Decision-maker", kept: 0.06, sample: 3194 },
      ])?.to,
    ).toBe("Decision-maker");
  });

  it("requires a sample of at least MIN_LEAK_SAMPLE", () => {
    // A literal `expect(MIN_LEAK_SAMPLE).toBe(10)` only dies to a mutation of
    // the literal itself -- no behavioural test would notice, and the
    // constant is meant to be tunable. Pin the floor by its effect instead,
    // referencing the constant rather than hardcoding 9 and 10.
    expect(
      worstDrop([
        { from: "Attended", to: "Sold", kept: 0, sample: MIN_LEAK_SAMPLE - 1 },
      ]),
    ).toBeNull();
    expect(
      worstDrop([
        { from: "Attended", to: "Sold", kept: 0, sample: MIN_LEAK_SAMPLE },
      ]),
    ).not.toBeNull();
  });
});

describe("buildInsights still reports the same leak after the extraction", () => {
  const kpis = {
    totalCalls: 8156,
    goalMet: 20,
    costPerGoalMet: 37.4,
  } as Parameters<typeof buildInsights>[0]["kpis"];

  it("names the biggest step-over-step drop, as it always did", () => {
    // Drops are 57.5%, 62.4% and 84.0% -- the last one wins.
    const insight = buildInsights({
      kpis,
      prior: null,
      funnel: [
        { label: "Called", count: 7518 },
        { label: "Connected", count: 3194 },
        { label: "Conversations", count: 1200 },
        { label: "Decision-makers", count: 192 },
      ],
      ranking: [],
    });
    expect(insight.detail).toContain("Conversations → Decision-makers");
    expect(insight.detail).toContain("84%");
  });

  it("says nothing about a leak when the funnel holds up", () => {
    const insight = buildInsights({
      kpis,
      prior: null,
      funnel: [
        { label: "Called", count: 100 },
        { label: "Connected", count: 100 },
      ],
      ranking: [],
    });
    expect(insight.detail).not.toContain("Biggest drop-off");
  });
});

describe("buildInsights: the sample floor worstDrop now enforces on the funnel", () => {
  // buildInsights hands worstDrop `sample: prev`, the previous step's count.
  // That gives this funnel a sample floor (MIN_LEAK_SAMPLE) it never enforced
  // before the extraction: an 89% drop off nine calls is noise, not a
  // bottleneck. Pinning both sides of the boundary is the only way to be
  // sure the floor landed instead of silently dropping the sentence for
  // every funnel, big or small.
  const kpis = {
    totalCalls: 10,
    goalMet: 0,
    costPerGoalMet: 0,
  } as Parameters<typeof buildInsights>[0]["kpis"];

  it("says too few calls rather than naming a bottleneck under the floor", () => {
    const insight = buildInsights({
      kpis,
      prior: null,
      funnel: [
        { label: "Called", count: 9 },
        { label: "Connected", count: 1 },
      ],
      ranking: [],
    });
    expect(insight.detail).not.toContain("Biggest drop-off");
    expect(insight.detail).toContain("Too few calls");
  });

  it("still names the drop-off once the funnel clears the floor", () => {
    const insight = buildInsights({
      kpis,
      prior: null,
      funnel: [
        { label: "Called", count: 10 },
        { label: "Connected", count: 1 },
      ],
      ranking: [],
    });
    expect(insight.detail).toContain("Biggest drop-off is Called → Connected");
    expect(insight.detail).toContain("90%");
  });
});
