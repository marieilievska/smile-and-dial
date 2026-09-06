// tests/humanize-minutes.unit.test.ts
import { describe, expect, it } from "vitest";

import { humanizeMinutes } from "@/lib/relative-time";
import { formatScheduledWhen } from "@/app/(app)/callbacks/format-when";

describe("humanizeMinutes", () => {
  it("floors sub-minute durations rather than showing 0m", () => {
    expect(humanizeMinutes(0)).toBe("<1m");
  });

  it("shows plain minutes under an hour", () => {
    expect(humanizeMinutes(1)).toBe("1m");
    expect(humanizeMinutes(59)).toBe("59m");
  });

  it("drops the minutes part when it is exactly on the hour", () => {
    expect(humanizeMinutes(60)).toBe("1h");
    expect(humanizeMinutes(180)).toBe("3h");
  });

  it("shows hours and minutes in between", () => {
    expect(humanizeMinutes(75)).toBe("1h 15m");
    expect(humanizeMinutes(200)).toBe("3h 20m");
  });

  it("rolls over into days past 24 hours", () => {
    expect(humanizeMinutes(1440)).toBe("1d");
    expect(humanizeMinutes(1500)).toBe("1d 1h");
    // The real case that prompted this: Today printed "1759m overdue".
    expect(humanizeMinutes(1759)).toBe("1d 5h");
    expect(humanizeMinutes(2880)).toBe("2d");
  });

  it("never reports a bare minute count above an hour", () => {
    for (const min of [61, 500, 1759, 5000, 100_000]) {
      expect(humanizeMinutes(min)).not.toMatch(/^\d+m$/);
    }
  });
});

describe("formatScheduledWhen uses the shared helper", () => {
  const now = new Date("2026-09-06T19:00:00Z");

  it("reports a day-plus overdue callback in days, not minutes", () => {
    // 1,759 minutes before `now` — the live case from the audit.
    const scheduled = new Date(now.getTime() - 1759 * 60_000).toISOString();
    const out = formatScheduledWhen(scheduled, now);
    expect(out.urgency).toBe("overdue");
    expect(out.primary).toBe("Overdue 1d 5h");
  });

  it("still reports a fresh overdue callback in minutes", () => {
    const scheduled = new Date(now.getTime() - 20 * 60_000).toISOString();
    expect(formatScheduledWhen(scheduled, now).primary).toBe("Overdue 20m");
  });
});
