import { describe, expect, it } from "vitest";

import { ToolTimer } from "../src/lib/elevenlabs/tool-timing";

/** A clock we drive by hand, so these assert real arithmetic rather than
 *  whatever the machine happened to take. */
function fakeClock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("ToolTimer", () => {
  it("records each step under its own <name>_ms key, plus a total", async () => {
    const clock = fakeClock();
    const timer = new ToolTimer(clock.now);
    await timer.time("context", async () => {
      clock.advance(40);
      return "ctx";
    });
    clock.advance(5); // work between steps counts only toward the total
    await timer.time("calendly_availability", async () => {
      clock.advance(1300);
      return [];
    });
    expect(timer.snapshot()).toEqual({
      context_ms: 40,
      calendly_availability_ms: 1300,
      total_ms: 1345,
    });
  });

  it("returns the step's own value", async () => {
    const timer = new ToolTimer(fakeClock().now);
    await expect(timer.time("context", async () => 42)).resolves.toBe(42);
  });

  it("adds up repeated steps (two Calendly calls read as one Calendly total)", async () => {
    const clock = fakeClock();
    const timer = new ToolTimer(clock.now);
    for (const ms of [200, 300]) {
      await timer.time("calendly_booking", async () => clock.advance(ms));
    }
    expect(timer.snapshot().calendly_booking_ms).toBe(500);
  });

  it("times a step that throws — a slow failure is the interesting kind", async () => {
    const clock = fakeClock();
    const timer = new ToolTimer(clock.now);
    await expect(
      timer.time("calendly_booking", async () => {
        clock.advance(900);
        throw new Error("Calendly said no");
      }),
    ).rejects.toThrow("Calendly said no");
    expect(timer.snapshot().calendly_booking_ms).toBe(900);
  });

  it("accepts a duration measured elsewhere", () => {
    const clock = fakeClock();
    const timer = new ToolTimer(clock.now);
    timer.add("calendly_availability", 1234.6);
    expect(timer.snapshot().calendly_availability_ms).toBe(1235);
  });

  it("reports only a total when nothing was timed", () => {
    const clock = fakeClock();
    const timer = new ToolTimer(clock.now);
    clock.advance(7);
    expect(timer.snapshot()).toEqual({ total_ms: 7 });
  });
});
