import { describe, expect, it } from "vitest";
import {
  dateRangeLabel,
  etDate,
  etDateTime,
  etDateTimeExact,
  etDayDelta,
  etPastLabel,
  etTime,
  etWallClock,
  etWallClockToIso,
  ymdLabel,
} from "@/lib/time/eastern";

// 2026-09-03T04:15:01Z is 12:15 AM EDT on Sep 3 (the HERBOX SPA call that
// showed as "4 AM" when rendered in UTC).
const HERBOX = "2026-09-03T04:15:01.966+00:00";

describe("Eastern display helpers", () => {
  it("renders clock times in Eastern, not UTC or the machine zone", () => {
    expect(etDateTime(HERBOX)).toBe("Sep 3, 12:15 AM");
    expect(etTime("2026-09-03T01:43:48Z")).toBe("9:43 PM");
    expect(etTime("2026-09-03T01:43:48Z", "", true)).toBe("9:43 PM EDT");
  });

  it("uses the Eastern calendar day, so a 9:43 PM call stays on Sep 2", () => {
    expect(
      etDate("2026-09-03T01:43:48Z", "", new Date("2026-09-03T12:00Z")),
    ).toBe("Sep 2");
    expect(etDayDelta(new Date("2026-09-03T01:43:48Z"), new Date(HERBOX))).toBe(
      1,
    );
  });

  it("adds the year only when it differs from now", () => {
    const now = new Date("2026-09-03T12:00Z");
    expect(etDate("2025-12-31T23:30:00-05:00", "", now)).toBe("Dec 31, 2025");
    expect(etDate("2026-01-01T00:30:00-05:00", "", now)).toBe("Jan 1");
  });

  it("handles standard time (EST) too", () => {
    expect(etDateTimeExact("2026-01-15T14:00:00Z")).toBe(
      "1/15/2026, 9:00:00 AM EST",
    );
  });

  it("buckets past labels by Eastern day", () => {
    const now = new Date("2026-09-03T13:00:00Z"); // 9:00 AM EDT Sep 3
    expect(etPastLabel("2026-09-03T12:59:30Z", now)).toBe("just now");
    expect(etPastLabel("2026-09-03T12:15:00Z", now)).toBe("45m ago");
    expect(etPastLabel("2026-09-03T05:00:00Z", now)).toBe("8h ago"); // 1 AM EDT, same ET day
    expect(etPastLabel("2026-09-03T01:43:48Z", now)).toBe("Yesterday"); // 9:43 PM EDT Sep 2
    expect(etPastLabel("2026-08-31T15:00:00Z", now)).toBe("Mon");
    expect(etPastLabel("2026-08-20T15:00:00Z", now)).toBe("Aug 20");
    expect(etPastLabel("2025-08-20T15:00:00Z", now)).toBe("Aug 20, 2025");
    expect(etPastLabel(null, now)).toBe("—");
  });

  it("labels YYYY-MM-DD ranges without shifting the date", () => {
    expect(dateRangeLabel("2026-09-01", "2026-09-27")).toBe("Sep 1 – Sep 27");
    expect(dateRangeLabel("2026-09-01", "2026-09-01")).toBe("Sep 1");
  });
});

describe("Eastern wall-clock bridge for datetime-local inputs", () => {
  it("round-trips an instant through the ET wall clock", () => {
    // 2026-09-03T04:15Z = 12:15 AM EDT Sep 3
    expect(etWallClock("2026-09-03T04:15:01Z")).toBe("2026-09-03T00:15");
    expect(etWallClockToIso("2026-09-03T00:15")).toBe(
      "2026-09-03T04:15:00.000Z",
    );
    // EST (no DST): 9:00 AM Jan 15 = 14:00Z
    expect(etWallClockToIso("2026-01-15T09:00")).toBe(
      "2026-01-15T14:00:00.000Z",
    );
    expect(etWallClockToIso("garbage")).toBeNull();
  });

  it("labels YYYY-MM-DD without a day shift", () => {
    expect(ymdLabel("2026-05-12")).toBe("May 12");
    expect(ymdLabel("2024-05-12", true)).toBe("May 12, 2024");
  });
});
