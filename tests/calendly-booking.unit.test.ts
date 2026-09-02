import { describe, expect, it } from "vitest";

import type { CalendlyCustomQuestion } from "../src/lib/calendly/booking";
import {
  availabilityWindows,
  bookingTracking,
  buildInviteeLocation,
  buildQuestionsAndAnswers,
  normalizeUtmCampaign,
  OFFER_LOOKAHEAD_DAYS,
  relativeDayLabel,
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

  it("a caller-supplied span yields one short window of exactly that length", () => {
    // The daily-webinar offer uses a single OFFER_LOOKAHEAD_DAYS window.
    const [w, ...rest] = availabilityWindows(now, {
      windows: 1,
      spanDays: OFFER_LOOKAHEAD_DAYS,
    });
    expect(rest).toHaveLength(0);
    const span = new Date(w.endISO).getTime() - new Date(w.startISO).getTime();
    expect(span).toBe(OFFER_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
  });

  it("clamps a span above Calendly's 7-day per-query cap", () => {
    const [w] = availabilityWindows(now, { windows: 1, spanDays: 30 });
    const span = new Date(w.endISO).getTime() - new Date(w.startISO).getTime();
    expect(span).toBeLessThan(7 * 24 * 60 * 60 * 1000);
  });
});

describe("OFFER_LOOKAHEAD_DAYS", () => {
  it("covers the host's ~4-day booking range but stays inside one Calendly query", () => {
    expect(OFFER_LOOKAHEAD_DAYS).toBeGreaterThanOrEqual(4);
    expect(OFFER_LOOKAHEAD_DAYS).toBeLessThan(7);
  });
});

describe("relativeDayLabel", () => {
  // Tuesday 2026-09-01, 10:00 in New York (14:00Z).
  const nowNY = Date.UTC(2026, 8, 1, 14, 0, 0);

  it("says today / tomorrow / the weekday for a short look-ahead", () => {
    // 2 PM Eastern sessions (18:00Z) on Sept 1, 2, 3.
    expect(
      relativeDayLabel("2026-09-01T18:00:00Z", nowNY, "America/New_York"),
    ).toBe("today");
    expect(
      relativeDayLabel("2026-09-02T18:00:00Z", nowNY, "America/New_York"),
    ).toBe("tomorrow");
    expect(
      relativeDayLabel("2026-09-03T18:00:00Z", nowNY, "America/New_York"),
    ).toBe("Thursday");
  });

  it("counts days on the LEAD's calendar, not UTC", () => {
    // 11:30 PM Pacific on Sept 1 is already Sept 2 in UTC (06:30Z). The 11 AM
    // Pacific session on Sept 2 (18:00Z) is the lead's TOMORROW — a UTC-based
    // diff would call it "today" and the agent would say the wrong day.
    const latePacificEvening = Date.UTC(2026, 8, 2, 6, 30, 0);
    expect(
      relativeDayLabel(
        "2026-09-02T18:00:00Z",
        latePacificEvening,
        "America/Los_Angeles",
      ),
    ).toBe("tomorrow");
  });

  it("falls back to Eastern when the lead has no timezone, and is empty for junk", () => {
    expect(relativeDayLabel("2026-09-02T18:00:00Z", nowNY, null)).toBe(
      "tomorrow",
    );
    expect(relativeDayLabel("not a date", nowNY, "America/New_York")).toBe("");
  });
});

describe("bookingTracking", () => {
  it("tags the active webinar campaign with the fixed voice_ai_webinar UTMs", () => {
    for (const campaignId of [
      "3cd40c9c-5a42-4476-9ef1-c6a1e0fc72d8", // HireAI Webinar Invite (post-workspace-switch)
    ]) {
      expect(
        bookingTracking({
          campaignId,
          campaignName: "HireAI Webinar",
          leadId: "lead-1",
        }),
      ).toEqual({
        utm_source: "smile_dial",
        utm_medium: "voice",
        utm_campaign: "voice_ai_webinar_27",
        utm_content: "voice_ai_webinar_27",
        utm_term: "voice_ai",
        salesforce_uuid: "lead-1",
      });
    }
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

  it("the campaign's own Booking UTM setting wins over the legacy map AND the name", () => {
    // The daily webinar: operator set booking_utm_campaign on the campaign.
    // Even for an id that is in the legacy map, the setting must win.
    const t = bookingTracking({
      campaignId: "3cd40c9c-5a42-4476-9ef1-c6a1e0fc72d8",
      campaignName: "HireAI Webinar",
      leadId: "lead-4",
      bookingUtmCampaign: "ai_voice_training_daily",
    });
    expect(t.utm_campaign).toBe("ai_voice_training_daily");
    expect(t.utm_content).toBe("ai_voice_training_daily");
    expect(t.utm_source).toBe("smile_dial");
    expect(t.utm_medium).toBe("voice");
    expect(t.salesforce_uuid).toBe("lead-4");
  });

  it("a blank or junk setting falls through to the old behaviour", () => {
    for (const blank of ["", "   ", "$$$", null, undefined]) {
      expect(
        bookingTracking({
          campaignId: "some-other-id",
          campaignName: "Med Spa Q3",
          leadId: "lead-5",
          bookingUtmCampaign: blank,
        }).utm_campaign,
      ).toBe("Med Spa Q3");
    }
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

describe("normalizeUtmCampaign", () => {
  it("lower-cases, joins words with underscores and strips everything else", () => {
    expect(normalizeUtmCampaign("  AI Voice Training Daily ")).toBe(
      "ai_voice_training_daily",
    );
    expect(normalizeUtmCampaign("ai_voice_training_daily")).toBe(
      "ai_voice_training_daily",
    );
    expect(normalizeUtmCampaign("Webinar (Sept) #2!")).toBe("webinar_sept_2");
  });

  it("is empty for nothing usable, and caps at 100 chars", () => {
    expect(normalizeUtmCampaign("")).toBe("");
    expect(normalizeUtmCampaign("   ")).toBe("");
    expect(normalizeUtmCampaign("$$$")).toBe("");
    expect(normalizeUtmCampaign(null)).toBe("");
    expect(normalizeUtmCampaign(undefined)).toBe("");
    expect(normalizeUtmCampaign("a".repeat(150))).toHaveLength(100);
  });
});

describe("buildQuestionsAndAnswers", () => {
  // The real event type that broke booking on 2026-08-18: a required free-text
  // "Company name" question was added to the webinar's Calendly form. Our
  // POST /invitees sent no answers, so Calendly rejected EVERY booking with
  // "Required Questions and Answers cannot be blank." — and the caller heard
  // "that time just became unavailable". 23 warm leads were turned away before
  // it was caught.
  const webinarQuestions: CalendlyCustomQuestion[] = [
    {
      name: "Company name",
      type: "string",
      position: 0,
      required: true,
      enabled: true,
      answer_choices: [],
    },
    {
      name: "Which best describes you?",
      type: "single_select",
      position: 1,
      required: false,
      enabled: true,
      answer_choices: [
        "Current Referrizer client",
        "Past client",
        "New to Referrizer",
        "REX Member",
      ],
    },
  ];

  const lead = {
    company: "Alaska Healing Arts",
    name: "Roberta",
    email: "alaskahealingarts@gmail.com",
    phone: "+19075551234",
  };

  it("answers the required company question with the lead's company", () => {
    expect(buildQuestionsAndAnswers(webinarQuestions, lead)).toEqual([
      { question: "Company name", answer: "Alaska Healing Arts", position: 0 },
    ]);
  });

  it("leaves OPTIONAL questions alone — a wrong select value can get the whole booking rejected", () => {
    const answers = buildQuestionsAndAnswers(webinarQuestions, lead);
    expect(
      answers.some((a) => a.question === "Which best describes you?"),
    ).toBe(false);
  });

  it("never emits a blank answer — a blank is exactly what Calendly rejects", () => {
    // No company on the lead: still must produce a non-empty answer.
    const answers = buildQuestionsAndAnswers(webinarQuestions, {
      ...lead,
      company: "",
    });
    expect(answers).toHaveLength(1);
    expect(answers[0].answer.trim().length).toBeGreaterThan(0);
  });

  it("routes by question wording — name, phone and email questions get the right fact", () => {
    const qs: CalendlyCustomQuestion[] = [
      {
        name: "Your full name",
        type: "string",
        position: 0,
        required: true,
        enabled: true,
        answer_choices: [],
      },
      {
        name: "Best phone number",
        type: "phone_number",
        position: 1,
        required: true,
        enabled: true,
        answer_choices: [],
      },
      {
        name: "Work email",
        type: "string",
        position: 2,
        required: true,
        enabled: true,
        answer_choices: [],
      },
      {
        name: "Business name",
        type: "string",
        position: 3,
        required: true,
        enabled: true,
        answer_choices: [],
      },
    ];
    expect(buildQuestionsAndAnswers(qs, lead)).toEqual([
      { question: "Your full name", answer: "Roberta", position: 0 },
      { question: "Best phone number", answer: "+19075551234", position: 1 },
      {
        question: "Work email",
        answer: "alaskahealingarts@gmail.com",
        position: 2,
      },
      { question: "Business name", answer: "Alaska Healing Arts", position: 3 },
    ]);
  });

  it("answers a REQUIRED select with one of its own choices (a free-text answer is rejected)", () => {
    const qs: CalendlyCustomQuestion[] = [
      {
        name: "Which best describes you?",
        type: "single_select",
        position: 0,
        required: true,
        enabled: true,
        answer_choices: ["Current Referrizer client", "New to Referrizer"],
      },
    ];
    const [a] = buildQuestionsAndAnswers(qs, lead);
    expect(qs[0].answer_choices).toContain(a.answer);
  });

  it("skips a DISABLED required question — it isn't on the form", () => {
    const qs: CalendlyCustomQuestion[] = [
      { ...webinarQuestions[0], enabled: false },
    ];
    expect(buildQuestionsAndAnswers(qs, lead)).toEqual([]);
  });

  it("returns [] when the event type has no custom questions (field must be omitted)", () => {
    expect(buildQuestionsAndAnswers([], lead)).toEqual([]);
    expect(buildQuestionsAndAnswers(null, lead)).toEqual([]);
    expect(buildQuestionsAndAnswers(undefined, lead)).toEqual([]);
  });

  it("preserves the question text EXACTLY — Calendly matches it case-sensitively", () => {
    const [a] = buildQuestionsAndAnswers(webinarQuestions, lead);
    expect(a.question).toBe("Company name");
  });
});
