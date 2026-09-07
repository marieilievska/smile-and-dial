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

  it("requires a sample of at least ten", () => {
    expect(MIN_LEAK_SAMPLE).toBe(10);
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
