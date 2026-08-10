import { describe, expect, test } from "vitest";

import {
  decideCallbackSweep,
  type CallbackSweepRow,
} from "@/lib/callbacks/sweep";

function row(
  p: Partial<CallbackSweepRow> & { callbackId: string; leadId: string },
): CallbackSweepRow {
  return {
    scheduledAt: "2026-08-10T12:00:00+00:00",
    leadStatus: "callback",
    leadLineType: null,
    leadDeleted: false,
    ...p,
  };
}

describe("decideCallbackSweep", () => {
  test("cancels pending callbacks whose lead is terminal (goal_met/dnc/resting)", () => {
    const plan = decideCallbackSweep([
      row({ callbackId: "c1", leadId: "L1", leadStatus: "goal_met" }),
      row({ callbackId: "c2", leadId: "L2", leadStatus: "dnc" }),
      row({ callbackId: "c3", leadId: "L3", leadStatus: "resting" }),
    ]);
    expect([...plan.cancelCallbackIds].sort()).toEqual(["c1", "c2", "c3"]);
    expect(plan.resync).toEqual([]);
  });

  test("re-syncs a ready_to_call lead to its EARLIEST pending callback", () => {
    const plan = decideCallbackSweep([
      row({
        callbackId: "c1",
        leadId: "L1",
        leadStatus: "ready_to_call",
        scheduledAt: "2026-08-10T15:00:00+00:00",
      }),
      row({
        callbackId: "c2",
        leadId: "L1",
        leadStatus: "ready_to_call",
        scheduledAt: "2026-08-10T09:00:00+00:00",
      }),
    ]);
    expect(plan.cancelCallbackIds).toEqual([]);
    expect(plan.resync).toEqual([
      { leadId: "L1", nextCallAt: "2026-08-10T09:00:00+00:00" },
    ]);
  });

  test("leaves correctly-parked callback-status leads alone", () => {
    const plan = decideCallbackSweep([
      row({ callbackId: "c1", leadId: "L1", leadStatus: "callback" }),
    ]);
    expect(plan.cancelCallbackIds).toEqual([]);
    expect(plan.resync).toEqual([]);
  });

  test("does NOT re-sync a mobile ready_to_call lead (mobiles never auto-dial)", () => {
    const plan = decideCallbackSweep([
      row({
        callbackId: "c1",
        leadId: "L1",
        leadStatus: "ready_to_call",
        leadLineType: "mobile",
      }),
    ]);
    expect(plan.cancelCallbackIds).toEqual([]);
    expect(plan.resync).toEqual([]);
  });

  test("cancels callbacks on a soft-deleted lead", () => {
    const plan = decideCallbackSweep([
      row({
        callbackId: "c1",
        leadId: "L1",
        leadStatus: "ready_to_call",
        leadDeleted: true,
      }),
    ]);
    expect(plan.cancelCallbackIds).toEqual(["c1"]);
    expect(plan.resync).toEqual([]);
  });
});
