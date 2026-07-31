import { describe, expect, it } from "vitest";

import {
  availabilityWindows,
  bookingTracking,
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

describe("bookingTracking", () => {
  it("tags the HireAI Webinar campaign with the fixed voice_ai_webinar UTMs", () => {
    expect(
      bookingTracking({
        campaignId: "17a7a2e8-c56b-4c3e-841c-a1db2fbf1529",
        campaignName: "HireAI Webinar",
        leadId: "lead-1",
      }),
    ).toEqual({
      utm_source: "smile_dial",
      utm_medium: "voice",
      utm_campaign: "voice_ai_webinar",
      utm_content: "voice_ai_webinar",
      utm_term: "voice_ai",
      salesforce_uuid: "lead-1",
    });
  });

  it("falls back to smile_dial + the campaign's own name for other campaigns", () => {
    expect(
      bookingTracking({
        campaignId: "some-other-id",
        campaignName: "Med Spa Q3",
        leadId: "lead-2",
      }),
    ).toEqual({
      utm_source: "smile_dial",
      utm_medium: "voice",
      utm_campaign: "Med Spa Q3",
      utm_content: "Med Spa Q3",
      utm_term: "voice_ai",
      salesforce_uuid: "lead-2",
    });
  });

  it("returns a COMPLETE (non-partial) object even with no campaign — Calendly rejects a partial tracking object", () => {
    const t = bookingTracking({
      campaignId: null,
      campaignName: null,
      leadId: "lead-3",
    });
    // Every field non-empty; a partial object is what broke booking.
    for (const v of Object.values(t)) expect(v).toBeTruthy();
    expect(t.salesforce_uuid).toBe("lead-3");
    expect(t.utm_source).toBe("smile_dial");
    expect(t.utm_medium).toBe("voice");
  });
});
