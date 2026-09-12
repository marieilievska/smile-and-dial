import { describe, expect, it } from "vitest";

import { whenPhrase } from "../src/lib/elevenlabs/opening-line";

/**
 * The "when" a follow-up opener says ("I called yesterday…"). Counted in
 * CALENDAR days on the lead's own clock. The old humanRecency in
 * conversation-init counted 24-hour blocks, so a 5 PM call still read
 * "earlier today" at 9 AM the next morning.
 */

// Saturday 2026-09-12, 10:00 AM in Chicago (CDT, UTC-5).
const NOW = new Date("2026-09-12T15:00:00Z");
const CHICAGO = "America/Chicago";

describe("whenPhrase", () => {
  it("same local day → earlier today", () => {
    expect(whenPhrase("2026-09-12T13:30:00Z", NOW, CHICAGO)).toBe(
      "earlier today",
    );
  });

  it("yesterday 5 PM read at 10 AM is 'yesterday' (the old 24-hour-block bug said 'earlier today')", () => {
    expect(whenPhrase("2026-09-11T22:00:00Z", NOW, CHICAGO)).toBe("yesterday");
  });

  it("2–6 days → the weekday", () => {
    expect(whenPhrase("2026-09-09T15:00:00Z", NOW, CHICAGO)).toBe(
      "on Wednesday",
    );
    expect(whenPhrase("2026-09-06T15:00:00Z", NOW, CHICAGO)).toBe("on Sunday");
  });

  it("7–13 days → last week", () => {
    expect(whenPhrase("2026-09-05T15:00:00Z", NOW, CHICAGO)).toBe("last week");
    expect(whenPhrase("2026-08-30T15:00:00Z", NOW, CHICAGO)).toBe("last week");
  });

  it("14–29 days → a few weeks ago", () => {
    expect(whenPhrase("2026-08-29T15:00:00Z", NOW, CHICAGO)).toBe(
      "a few weeks ago",
    );
    expect(whenPhrase("2026-08-14T15:00:00Z", NOW, CHICAGO)).toBe(
      "a few weeks ago",
    );
  });

  it("30–59 days → about a month ago (the 30-day 'not interested' rest)", () => {
    expect(whenPhrase("2026-08-13T15:00:00Z", NOW, CHICAGO)).toBe(
      "about a month ago",
    );
    expect(whenPhrase("2026-07-15T15:00:00Z", NOW, CHICAGO)).toBe(
      "about a month ago",
    );
  });

  it("60+ days → a couple of months ago", () => {
    expect(whenPhrase("2026-07-14T15:00:00Z", NOW, CHICAGO)).toBe(
      "a couple of months ago",
    );
  });

  it("counts days on the LEAD's calendar, not Eastern", () => {
    // 11:30 PM Pacific on Sep 11 is already 2:30 AM Sep 12 in New York.
    const nineAmPacific = new Date("2026-09-12T16:00:00Z");
    expect(
      whenPhrase("2026-09-12T06:30:00Z", nineAmPacific, "America/Los_Angeles"),
    ).toBe("yesterday");
    expect(
      whenPhrase("2026-09-12T06:30:00Z", nineAmPacific, "America/New_York"),
    ).toBe("earlier today");
  });

  it("stays whole-day across a daylight-saving change", () => {
    // US DST ends 2026-11-01: noon Sat Oct 31 EDT → noon Mon Nov 2 EST = 2 days.
    expect(
      whenPhrase(
        "2026-10-31T16:00:00Z",
        new Date("2026-11-02T17:00:00Z"),
        "America/New_York",
      ),
    ).toBe("on Saturday");
  });

  it("missing or unusable timezone → Eastern", () => {
    // 6 PM ET Friday vs 11 AM ET Saturday.
    expect(whenPhrase("2026-09-11T22:00:00Z", NOW, null)).toBe("yesterday");
    expect(whenPhrase("2026-09-11T22:00:00Z", NOW, "Not/AZone")).toBe(
      "yesterday",
    );
  });

  it("no usable timestamp → recently", () => {
    expect(whenPhrase(null, NOW, CHICAGO)).toBe("recently");
    expect(whenPhrase("not a date", NOW, CHICAGO)).toBe("recently");
  });
});
