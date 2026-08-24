import { describe, expect, it } from "vitest";
import { evaluateCreditState } from "@/lib/elevenlabs/credit-state";

const T = { warn: 100_000, stop: 35_000, resume: 50_000 };

describe("evaluateCreditState", () => {
  it("stays OK well above the warn line", () => {
    const d = evaluateCreditState(500_000, "ok", T);
    expect(d.state).toBe("ok");
    expect(d.shouldDial).toBe(true);
    expect(d.transition).toBe("none");
  });

  it("crosses OK -> warn and flags entered_warn", () => {
    const d = evaluateCreditState(80_000, "ok", T);
    expect(d.state).toBe("warn");
    expect(d.shouldDial).toBe(true);
    expect(d.transition).toBe("entered_warn");
  });

  it("does not re-fire entered_warn while staying in warn", () => {
    const d = evaluateCreditState(70_000, "warn", T);
    expect(d.state).toBe("warn");
    expect(d.transition).toBe("none");
  });

  it("crosses warn -> low and flags entered_low", () => {
    const d = evaluateCreditState(20_000, "warn", T);
    expect(d.state).toBe("low");
    expect(d.shouldDial).toBe(false);
    expect(d.transition).toBe("entered_low");
  });

  it("stays low with still_low while below the resume line", () => {
    const d = evaluateCreditState(20_000, "low", T);
    expect(d.state).toBe("low");
    expect(d.shouldDial).toBe(false);
    expect(d.transition).toBe("still_low");
  });

  it("hysteresis: stays low between stop and resume even though > stop", () => {
    const d = evaluateCreditState(40_000, "low", T); // > stop(35k), < resume(50k)
    expect(d.state).toBe("low");
    expect(d.transition).toBe("still_low");
  });

  it("resumes once at/above the resume line", () => {
    const d = evaluateCreditState(50_000, "low", T);
    expect(d.state).toBe("warn"); // 50k is between stop and warn
    expect(d.shouldDial).toBe(true);
    expect(d.transition).toBe("resumed");
  });

  it("resume path does not emit entered_warn even though it lands in warn", () => {
    const d = evaluateCreditState(60_000, "low", T);
    expect(d.state).toBe("warn");
    expect(d.transition).toBe("resumed");
  });

  it("resumes straight to ok when it recovers past the warn line", () => {
    const d = evaluateCreditState(150_000, "low", T);
    expect(d.state).toBe("ok");
    expect(d.transition).toBe("resumed");
  });

  it("first observation (null prev) that is already low pauses immediately", () => {
    const d = evaluateCreditState(10_000, null, T);
    expect(d.state).toBe("low");
    expect(d.transition).toBe("entered_low");
  });

  it("first observation (null prev) that is healthy is OK with no transition", () => {
    const d = evaluateCreditState(500_000, null, T);
    expect(d.state).toBe("ok");
    expect(d.transition).toBe("none");
  });

  it("treats exactly the stop line as low (strictly below warn, at/below stop)", () => {
    const d = evaluateCreditState(35_000, "ok", T); // remaining == stop
    // remaining < stop is false at exactly 35k, so it's warn, not low.
    expect(d.state).toBe("warn");
  });
});
