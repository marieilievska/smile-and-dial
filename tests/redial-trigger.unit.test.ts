import { describe, expect, it } from "vitest";

import { shouldScheduleRedial } from "@/lib/dialer/redial";

/** An opted-in campaign, first cold call, hit voicemail — the case that fires. */
const FIRES = {
  doubleCallEnabled: true,
  outcome: "voicemail" as string | null,
  isRedial: false,
  retryPositionBefore: 0,
};

describe("shouldScheduleRedial", () => {
  it("fires on the happy path", () => {
    expect(shouldScheduleRedial(FIRES)).toBe(true);
  });

  it("never fires when the campaign has not opted in", () => {
    expect(shouldScheduleRedial({ ...FIRES, doubleCallEnabled: false })).toBe(
      false,
    );
  });

  it("fires only on voicemail", () => {
    for (const outcome of [
      "no_answer",
      "busy",
      "failed",
      "gatekeeper",
      "goal_met",
      "not_interested",
      "hung_up_immediately",
      "ai_receptionist",
      null,
    ]) {
      expect(shouldScheduleRedial({ ...FIRES, outcome })).toBe(false);
    }
  });

  it("fires at retry positions 0 and 2, never at 1", () => {
    expect(shouldScheduleRedial({ ...FIRES, retryPositionBefore: 0 })).toBe(
      true,
    );
    expect(shouldScheduleRedial({ ...FIRES, retryPositionBefore: 1 })).toBe(
      false,
    );
    expect(shouldScheduleRedial({ ...FIRES, retryPositionBefore: 2 })).toBe(
      true,
    );
  });

  it("handles a retry position that has run past 2", () => {
    // retry_position is stored modulo 3 by the engine, but never trust it.
    expect(shouldScheduleRedial({ ...FIRES, retryPositionBefore: 3 })).toBe(
      true,
    );
    expect(shouldScheduleRedial({ ...FIRES, retryPositionBefore: 4 })).toBe(
      false,
    );
    expect(shouldScheduleRedial({ ...FIRES, retryPositionBefore: 5 })).toBe(
      true,
    );
  });

  it("never lets a redial spawn another redial", () => {
    expect(shouldScheduleRedial({ ...FIRES, isRedial: true })).toBe(false);
    expect(
      shouldScheduleRedial({
        ...FIRES,
        isRedial: true,
        retryPositionBefore: 2,
      }),
    ).toBe(false);
  });
});
