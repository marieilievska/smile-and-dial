import { describe, expect, it } from "vitest";

import {
  availabilityWindows,
  buildInviteeLocation,
} from "../src/lib/calendly/booking";

describe("buildInviteeLocation", () => {
  it("echoes a host-defined Zoom location back so Calendly accepts the booking", () => {
    // Omitting this was the exact bug: Calendly returned
    // "location_configuration.kind invalid location choice" and the booking died.
    expect(buildInviteeLocation([{ kind: "zoom_conference" }])).toEqual({
      kind: "zoom_conference",
    });
  });

  it("uses the first location when several are present", () => {
    expect(
      buildInviteeLocation([
        { kind: "google_conference" },
        { kind: "zoom_conference" },
      ]),
    ).toEqual({ kind: "google_conference" });
  });

  it("returns undefined for a locationless event type (the field must be omitted)", () => {
    expect(buildInviteeLocation([])).toBeUndefined();
    expect(buildInviteeLocation(null)).toBeUndefined();
    expect(buildInviteeLocation(undefined)).toBeUndefined();
  });

  it("ignores a blank or invalid kind rather than sending an empty location", () => {
    expect(buildInviteeLocation([{ kind: "" }])).toBeUndefined();
    expect(buildInviteeLocation([{ kind: null }])).toBeUndefined();
  });
});

describe("availabilityWindows", () => {
  const now = Date.UTC(2026, 6, 30, 12, 0, 0); // 2026-07-30T12:00:00Z

  it("looks weeks ahead so a fixed date ~2 weeks out is covered (the webinar bug)", () => {
    const ws = availabilityWindows(now);
    const horizonMs =
      new Date(ws[ws.length - 1].endISO).getTime() -
      new Date(ws[0].startISO).getTime();
    // The single real webinar slot was 14 days out; the old 6-day window missed
    // it entirely. The horizon must comfortably clear two weeks.
    expect(horizonMs).toBeGreaterThan(14 * 24 * 60 * 60 * 1000);
  });

  it("keeps every window under Calendly's 7-day per-query cap", () => {
    for (const w of availabilityWindows(now)) {
      const span =
        new Date(w.endISO).getTime() - new Date(w.startISO).getTime();
      expect(span).toBeLessThan(7 * 24 * 60 * 60 * 1000);
    }
  });

  it("is gap-free — each window starts exactly where the previous one ended", () => {
    const ws = availabilityWindows(now);
    for (let i = 1; i < ws.length; i++) {
      expect(ws[i].startISO).toBe(ws[i - 1].endISO);
    }
  });

  it("starts a short lead after now, never in the past", () => {
    const ws = availabilityWindows(now, { leadMinutes: 15 });
    expect(new Date(ws[0].startISO).getTime()).toBe(now + 15 * 60 * 1000);
  });

  it("honors the requested window count", () => {
    expect(availabilityWindows(now, { windows: 3 })).toHaveLength(3);
  });
});
