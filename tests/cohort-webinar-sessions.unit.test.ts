import { describe, expect, it } from "vitest";

import { etTwoPmOn, upcomingSessions } from "../src/lib/goals/webinar-sessions";

const etLabel = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  });

describe("etTwoPmOn", () => {
  it("is 18:00 UTC during daylight saving (ET = UTC-4)", () => {
    expect(etTwoPmOn(new Date("2026-09-08T12:00:00Z")).toISOString()).toBe(
      "2026-09-08T18:00:00.000Z",
    );
  });

  it("is 19:00 UTC in winter (ET = UTC-5)", () => {
    // The whole reason the offset is derived rather than hardcoded: a fixed
    // 18:00Z would silently become 1 PM ET after the November changeover.
    expect(etTwoPmOn(new Date("2026-12-08T12:00:00Z")).toISOString()).toBe(
      "2026-12-08T19:00:00.000Z",
    );
  });

  it("still lands on 2 PM ET either side of the DST switch", () => {
    for (const d of ["2026-11-01T12:00:00Z", "2026-11-02T12:00:00Z"]) {
      const hour = new Date(etTwoPmOn(new Date(d))).toLocaleString("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        hour12: false,
      });
      expect(hour).toBe("14");
    }
  });
});

describe("upcomingSessions", () => {
  it("offers only weekdays", () => {
    // From a Friday, the next sessions must skip Saturday and Sunday.
    const sessions = upcomingSessions(3, new Date("2026-09-04T15:00:00Z"));
    const days = sessions.map((s) => etLabel(s.iso).split(",")[0]);
    expect(days).not.toContain("Sat");
    expect(days).not.toContain("Sun");
  });

  it("every option is 2 PM ET", () => {
    const sessions = upcomingSessions(5, new Date("2026-09-04T15:00:00Z"));
    for (const s of sessions) {
      expect(etLabel(s.iso).split(" ").at(-1)).toBe("14");
    }
  });

  it("skips today once today's session has already started", () => {
    // 3:30 PM ET on a Tuesday — that day's 2 PM is over, so it must not be
    // offered as somewhere to move to.
    const sessions = upcomingSessions(2, new Date("2026-09-08T19:30:00Z"));
    expect(sessions[0].iso > "2026-09-08T19:30:00Z").toBe(true);
  });

  it("still offers today when the session is later the same day", () => {
    // 9 AM ET on a Tuesday — that day's 2 PM is still ahead.
    const sessions = upcomingSessions(2, new Date("2026-09-08T13:00:00Z"));
    expect(sessions[0].iso).toBe("2026-09-08T18:00:00.000Z");
  });

  it("returns the number of sessions asked for", () => {
    expect(upcomingSessions(7, new Date("2026-09-04T15:00:00Z"))).toHaveLength(
      7,
    );
  });

  it("labels an option in a form a person can recognise", () => {
    // 11 AM ET on Friday — that day's own 2 PM session is still ahead, so it
    // is the first thing offered.
    const [first] = upcomingSessions(1, new Date("2026-09-04T15:00:00Z"));
    expect(first.label).toMatch(/Friday, Sep 4, 2:00 PM/);
  });

  it("rolls to Monday when Friday's session has already run", () => {
    // 3:30 PM ET on Friday — the weekend must be skipped entirely.
    const [first] = upcomingSessions(1, new Date("2026-09-04T19:30:00Z"));
    expect(first.label).toMatch(/Monday, Sep 7, 2:00 PM/);
  });
});
