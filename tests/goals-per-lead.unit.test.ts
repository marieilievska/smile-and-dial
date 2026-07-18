import { describe, it, expect } from "vitest";

import {
  computeKpis,
  bookingsByDay,
  rankCampaigns,
  type CallRow,
  type Slicers,
} from "../src/lib/analytics/stats";
import {
  computeDailyKpis,
  type AgentCallRow,
} from "../src/lib/agent-analytics/stats";

// A goal-met call on 2026-07-17 (18:00Z = 2pm ET → ET day 2026-07-17).
const AT = "2026-07-17T18:00:00.000Z";

function call(partial: Partial<CallRow>): CallRow {
  return {
    id: Math.random().toString(36).slice(2),
    campaign_id: "camp-A",
    lead_id: "lead-1",
    direction: "outbound",
    outcome: "goal_met",
    goal_met: true,
    duration_seconds: 120,
    talk_time_seconds: 120,
    cost_breakdown: { total: 1 },
    extracted_data: {},
    lead_decision_maker_reached: true,
    started_at: AT,
    created_at: AT,
    ...partial,
  };
}

const DAY: Slicers = { from: "2026-07-17", to: "2026-07-17" };

describe("goals counted per business (distinct lead)", () => {
  it("computeKpis: two goal-met calls on the SAME lead = one goal", () => {
    const rows = [call({ lead_id: "lead-1" }), call({ lead_id: "lead-1" })];
    expect(computeKpis(rows).goalMet).toBe(1);
  });

  it("computeKpis: two different leads = two goals", () => {
    const rows = [call({ lead_id: "lead-1" }), call({ lead_id: "lead-2" })];
    expect(computeKpis(rows).goalMet).toBe(2);
  });

  it("computeKpis: cost per goal divides spend by BUSINESSES won", () => {
    const rows = [
      call({ lead_id: "lead-1", cost_breakdown: { total: 3 } }),
      call({ lead_id: "lead-1", cost_breakdown: { total: 5 } }),
    ];
    const k = computeKpis(rows);
    expect(k.goalMet).toBe(1);
    expect(k.costPerGoalMet).toBe(8); // $8 spend / 1 business
  });

  it("bookingsByDay: same lead twice in a day counts once that day", () => {
    const rows = [call({ lead_id: "lead-1" }), call({ lead_id: "lead-1" })];
    // Single-day range → one bucket, which should be 1 (one business).
    expect(bookingsByDay(rows, DAY)).toEqual([1]);
  });

  it("rankCampaigns: same lead, same campaign = one; two campaigns credit each", () => {
    const rows = [
      call({ lead_id: "lead-1", campaign_id: "camp-A" }),
      call({ lead_id: "lead-1", campaign_id: "camp-A" }), // dup, same campaign
      call({ lead_id: "lead-1", campaign_id: "camp-B" }), // same biz, other campaign
    ];
    const ranked = rankCampaigns(
      rows,
      new Map([
        ["camp-A", "A"],
        ["camp-B", "B"],
      ]),
    );
    const a = ranked.find((r) => r.campaignId === "camp-A");
    const b = ranked.find((r) => r.campaignId === "camp-B");
    expect(a?.goalMet).toBe(1);
    expect(b?.goalMet).toBe(1);
  });

  it("computeDailyKpis (reporting): same lead twice in a day = one goal", () => {
    const rows: AgentCallRow[] = [
      {
        started_at: AT,
        outcome: "goal_met",
        duration_seconds: 120,
        extracted_data: {},
        lead_id: "lead-1",
      },
      {
        started_at: AT,
        outcome: "goal_met",
        duration_seconds: 120,
        extracted_data: {},
        lead_id: "lead-1",
      },
    ];
    const daily = computeDailyKpis(rows);
    expect(daily).toHaveLength(1);
    expect(daily[0].goals).toBe(1);
  });
});
