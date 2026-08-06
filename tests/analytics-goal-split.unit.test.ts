import { describe, expect, it } from "vitest";

import {
  buildLeadFunnel,
  computeKpis,
  type CallRow,
} from "@/lib/analytics/stats";

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
    lead_decision_maker_reached: false,
    started_at: AT,
    created_at: AT,
    ...partial,
  };
}

describe("funnel no longer nests goals under decision-makers", () => {
  it("ends at Decision-makers reached — there is no Goals met step", () => {
    const funnel = buildLeadFunnel([call({})]);
    expect(funnel.map((s) => s.label)).toEqual([
      "Called",
      "Connected",
      "Conversations",
      "Decision-makers reached",
    ]);
    expect(funnel.find((s) => s.label === "Goals met")).toBeUndefined();
  });

  it("a goal met WITHOUT reaching the DM does not inflate the DM stage", () => {
    // One business: goal met, but its lead DM flag is false. The old code folded
    // every goal into the DM stage, so DMs read 1 and the goal rate was 100%.
    const funnel = buildLeadFunnel([
      call({
        lead_id: "lead-1",
        goal_met: true,
        lead_decision_maker_reached: false,
      }),
    ]);
    const dm = funnel.find((s) => s.label === "Decision-makers reached");
    expect(dm?.count).toBe(0);
  });

  it("the DM stage counts only leads whose decision-maker flag is set", () => {
    const funnel = buildLeadFunnel([
      call({ lead_id: "lead-1", lead_decision_maker_reached: true }),
      call({ lead_id: "lead-2", lead_decision_maker_reached: false }),
    ]);
    expect(
      funnel.find((s) => s.label === "Decision-makers reached")?.count,
    ).toBe(1);
  });

  it("a met goal still counts as a conversation (goals ⊆ conversations)", () => {
    // Even a short goal-met call is a real conversation, so the goal-vs-
    // conversation rate can never exceed 100%.
    const funnel = buildLeadFunnel([
      call({
        lead_id: "lead-1",
        goal_met: true,
        talk_time_seconds: 5,
        duration_seconds: 20,
        lead_decision_maker_reached: false,
      }),
    ]);
    const conv = funnel.find((s) => s.label === "Conversations")?.count ?? 0;
    expect(conv).toBe(1);
  });
});

describe("computeKpis splits goals met into total and decision-maker subset", () => {
  it("counts the total and the DM subset as distinct businesses", () => {
    const rows = [
      call({ lead_id: "lead-1", lead_decision_maker_reached: true }),
      call({ lead_id: "lead-2", lead_decision_maker_reached: false }),
    ];
    const k = computeKpis(rows);
    expect(k.goalMet).toBe(2);
    expect(k.goalMetWithDm).toBe(1);
  });

  it("goalMetWithDm never exceeds goalMet", () => {
    const rows = [
      call({ lead_id: "lead-1", lead_decision_maker_reached: true }),
      call({ lead_id: "lead-1", lead_decision_maker_reached: true }), // same biz
      call({ lead_id: "lead-2", lead_decision_maker_reached: true }),
    ];
    const k = computeKpis(rows);
    expect(k.goalMet).toBe(2);
    expect(k.goalMetWithDm).toBe(2);
    expect(k.goalMetWithDm).toBeLessThanOrEqual(k.goalMet);
  });
});
