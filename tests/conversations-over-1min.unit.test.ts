import { describe, expect, it } from "vitest";

import {
  computeDailyKpis,
  type AgentCallRow,
} from "@/lib/agent-analytics/stats";

const AT = "2026-07-27T15:00:00.000Z";

function call(p: Partial<AgentCallRow>): AgentCallRow {
  return {
    started_at: AT,
    outcome: "gatekeeper",
    duration_seconds: 0,
    extracted_data: {},
    lead_id: "lead-1",
    ...p,
  };
}

/**
 * "Conversations >1 min" must mean we actually spoke to somebody.
 *
 * Duration on its own doesn't prove that: an auto-attendant menu can loop for
 * minutes and a voicemail greeting can run long, with no person ever speaking.
 * A real IVR call on 2026-07-27 ran 203 seconds and reached nobody.
 */
describe("conversations over 1 minute", () => {
  it("excludes a long voicemail", () => {
    const daily = computeDailyKpis([
      call({ outcome: "voicemail", duration_seconds: 203 }),
    ]);
    expect(daily[0].convGt1min).toBe(0);
    expect(daily[0].connected).toBe(0);
  });

  it("excludes a long call to an automated receptionist", () => {
    const daily = computeDailyKpis([
      call({ outcome: "ai_receptionist", duration_seconds: 180 }),
    ]);
    expect(daily[0].convGt1min).toBe(0);
  });

  it("excludes a long no-answer or failed call", () => {
    const daily = computeDailyKpis([
      call({ outcome: "no_answer", duration_seconds: 90 }),
      call({ outcome: "failed", duration_seconds: 120 }),
    ]);
    expect(daily[0].convGt1min).toBe(0);
  });

  it("counts a real conversation with a human", () => {
    const daily = computeDailyKpis([
      call({ outcome: "gatekeeper", duration_seconds: 61 }),
      call({ outcome: "goal_met", duration_seconds: 240 }),
      call({ outcome: "not_interested", duration_seconds: 75 }),
    ]);
    expect(daily[0].convGt1min).toBe(3);
  });

  it("still requires more than a minute, not just a human", () => {
    const daily = computeDailyKpis([
      call({ outcome: "goal_met", duration_seconds: 60 }),
      call({ outcome: "gatekeeper", duration_seconds: 12 }),
    ]);
    expect(daily[0].connected).toBe(2);
    expect(daily[0].convGt1min).toBe(0);
  });

  it("never exceeds the connected count", () => {
    // The old bug: a 203s voicemail scored 0 connected but 1 conversation,
    // so the funnel showed more conversations than connects.
    const daily = computeDailyKpis([
      call({ outcome: "voicemail", duration_seconds: 203 }),
      call({ outcome: "voicemail", duration_seconds: 300 }),
      call({ outcome: "goal_met", duration_seconds: 90 }),
    ]);
    expect(daily[0].connected).toBe(1);
    expect(daily[0].convGt1min).toBe(1);
    expect(daily[0].convGt1min).toBeLessThanOrEqual(daily[0].connected);
  });
});
