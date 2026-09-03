import { describe, expect, test } from "vitest";

import { agreedDayMatchesSlot } from "@/lib/calendly/agreed-day";

// The Pamper Me Skin Care incident (2026-09-03): the lead said "Tuesday", the
// only slot in the agent's list was today's (Thursday 2 PM ET), and the agent
// booked it anyway. Fixed points from that call:
const NY = "America/New_York";
const INCIDENT_NOW = Date.parse("2026-09-03T15:15:36Z");
const THURSDAY_SLOT = "2026-09-03T18:00:00Z"; // Thu Sep 3, 2:00 PM ET
const TUESDAY_SLOT = "2026-09-08T18:00:00Z"; // Tue Sep 8, 2:00 PM ET
const WEDNESDAY_SLOT = "2026-09-09T18:00:00Z"; // Wed Sep 9, 2:00 PM ET

describe("agreedDayMatchesSlot", () => {
  test("the incident: lead agreed to Tuesday, slot is today (Thursday) → mismatch", () => {
    const r = agreedDayMatchesSlot("Tuesday", THURSDAY_SLOT, INCIDENT_NOW, NY);
    expect(r.verdict).toBe("mismatch");
    expect(r.slotDay).toBe("today (Thursday, September 3)");
  });

  test("'today' matches today's slot", () => {
    expect(
      agreedDayMatchesSlot("today", THURSDAY_SLOT, INCIDENT_NOW, NY).verdict,
    ).toBe("match");
  });

  test("'tomorrow' does not match today's slot", () => {
    expect(
      agreedDayMatchesSlot("tomorrow", THURSDAY_SLOT, INCIDENT_NOW, NY).verdict,
    ).toBe("mismatch");
  });

  test("weekday word wins and matches the slot's local weekday ('Tuesday the 8th')", () => {
    const r = agreedDayMatchesSlot(
      "Tuesday the 8th",
      TUESDAY_SLOT,
      INCIDENT_NOW,
      NY,
    );
    expect(r.verdict).toBe("match");
    expect(r.slotDay).toBe("Tuesday, September 8");
  });

  test("a bare day-of-month ('the 8th') matches by day-of-month", () => {
    expect(
      agreedDayMatchesSlot("the 8th", TUESDAY_SLOT, INCIDENT_NOW, NY).verdict,
    ).toBe("match");
    expect(
      agreedDayMatchesSlot("the 8th", THURSDAY_SLOT, INCIDENT_NOW, NY).verdict,
    ).toBe("mismatch");
  });

  test("month + day and numeric dates resolve to the day-of-month", () => {
    expect(
      agreedDayMatchesSlot("sept 8", TUESDAY_SLOT, INCIDENT_NOW, NY).verdict,
    ).toBe("match");
    expect(
      agreedDayMatchesSlot("September 8", TUESDAY_SLOT, INCIDENT_NOW, NY)
        .verdict,
    ).toBe("match");
    expect(
      agreedDayMatchesSlot("9/8", TUESDAY_SLOT, INCIDENT_NOW, NY).verdict,
    ).toBe("match");
  });

  test("weekday abbreviations ('Tues', 'thurs', 'wed.') are understood", () => {
    expect(
      agreedDayMatchesSlot("Tues", TUESDAY_SLOT, INCIDENT_NOW, NY).verdict,
    ).toBe("match");
    expect(
      agreedDayMatchesSlot("thurs", THURSDAY_SLOT, INCIDENT_NOW, NY).verdict,
    ).toBe("match");
    expect(
      agreedDayMatchesSlot("wed.", WEDNESDAY_SLOT, INCIDENT_NOW, NY).verdict,
    ).toBe("match");
    expect(
      agreedDayMatchesSlot("Tues", THURSDAY_SLOT, INCIDENT_NOW, NY).verdict,
    ).toBe("mismatch");
  });

  test("'next wednesday' is just Wednesday", () => {
    expect(
      agreedDayMatchesSlot("next wednesday", WEDNESDAY_SLOT, INCIDENT_NOW, NY)
        .verdict,
    ).toBe("match");
  });

  test("a weekday word beats a clock time in the same phrase ('Tuesday at 2')", () => {
    expect(
      agreedDayMatchesSlot("Tuesday at 2", THURSDAY_SLOT, INCIDENT_NOW, NY)
        .verdict,
    ).toBe("mismatch");
  });

  test("empty, null and vague phrases are unrecognized (never a refusal)", () => {
    expect(
      agreedDayMatchesSlot("", THURSDAY_SLOT, INCIDENT_NOW, NY).verdict,
    ).toBe("unrecognized");
    expect(
      agreedDayMatchesSlot(null, THURSDAY_SLOT, INCIDENT_NOW, NY).verdict,
    ).toBe("unrecognized");
    expect(
      agreedDayMatchesSlot(undefined, THURSDAY_SLOT, INCIDENT_NOW, NY).verdict,
    ).toBe("unrecognized");
    expect(
      agreedDayMatchesSlot("whenever works", THURSDAY_SLOT, INCIDENT_NOW, NY)
        .verdict,
    ).toBe("unrecognized");
  });

  test("today/tomorrow are judged on the LEAD's calendar (Pacific lead late Wednesday night)", () => {
    // 2026-09-03T05:30Z is 10:30 PM Wednesday in Los Angeles; the 18:00Z slot
    // is Thursday 11 AM there — the lead's "tomorrow", not their "today".
    const LA = "America/Los_Angeles";
    const lateWed = Date.parse("2026-09-03T05:30:00Z");
    expect(
      agreedDayMatchesSlot("tomorrow", THURSDAY_SLOT, lateWed, LA).verdict,
    ).toBe("match");
    expect(
      agreedDayMatchesSlot("today", THURSDAY_SLOT, lateWed, LA).verdict,
    ).toBe("mismatch");
    expect(
      agreedDayMatchesSlot("tomorrow", THURSDAY_SLOT, lateWed, LA).slotDay,
    ).toBe("tomorrow (Thursday, September 3)");
  });

  test("an invalid slot is unrecognized rather than a refusal", () => {
    expect(
      agreedDayMatchesSlot("Tuesday", "not-a-date", INCIDENT_NOW, NY).verdict,
    ).toBe("unrecognized");
  });
});
