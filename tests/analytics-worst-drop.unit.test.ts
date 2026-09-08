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

describe("buildInsights leaves the leak to the funnel panel", () => {
  const kpis = {
    totalCalls: 8156,
    goalMet: 20,
    costPerGoalMet: 37.4,
  } as Parameters<typeof buildInsights>[0]["kpis"];

  const funnel = [
    { label: "Called", count: 7518 },
    { label: "Connected", count: 3194 },
    { label: "Conversations", count: 677 },
    { label: "Decision-makers reached", count: 192 },
  ];

  it("no longer names a bottleneck — the panel is the single answer", () => {
    // Two answers to "where is the leak" on one screen is worse than one,
    // especially when they disagree: this used to say Connected ->
    // Conversations while the panel said Decision-maker.
    const insight = buildInsights({ kpis, prior: null, funnel, ranking: [] });
    expect(insight.detail).not.toContain("drop-off");
    expect(insight.detail).not.toContain("bottleneck");
  });

  it("still says what a goal costs", () => {
    const insight = buildInsights({ kpis, prior: null, funnel, ranking: [] });
    expect(insight.detail).toContain("$37.40");
  });

  it("still leads with goals met and the trend", () => {
    const insight = buildInsights({ kpis, prior: null, funnel, ranking: [] });
    expect(insight.headline).toContain("20 goals met");
  });
});
