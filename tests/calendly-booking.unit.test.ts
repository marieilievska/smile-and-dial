import { describe, expect, it } from "vitest";

import type { CalendlyCustomQuestion } from "../src/lib/calendly/booking";
import {
  availabilityWindows,
  bookingPhoneAudit,
  bookingPhoneOutcome,
  bookingTracking,
  buildInviteeLocation,
  buildOptionalPhoneAnswer,
  buildQuestionsAndAnswers,
  isSlotGoneError,
  normalizeUtmCampaign,
  OFFER_LOOKAHEAD_DAYS,
  pickBookingPhone,
  relativeDayLabel,
  requiredQuestionPhone,
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

  it("a span of exactly 7 days is allowed — Calendly accepts a 7.0-day query (verified live 2026-09-03)", () => {
    const [w] = availabilityWindows(now, { windows: 1, spanDays: 7 });
    const span = new Date(w.endISO).getTime() - new Date(w.startISO).getTime();
    expect(span).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("clamps a span above Calendly's 7-day per-query cap to exactly 7 days", () => {
    for (const spanDays of [8, 30]) {
      const [w] = availabilityWindows(now, { windows: 1, spanDays });
      const span =
        new Date(w.endISO).getTime() - new Date(w.startISO).getTime();
      expect(span).toBe(7 * 24 * 60 * 60 * 1000);
    }
  });

  it("the offer window from a Thursday-morning call reaches next Wednesday's 2 PM ET session", () => {
    // The webinar runs weekdays at 2 PM ET and its booking range counts
    // BUSINESS days: 4 business days from a Thursday = next Wednesday. A
    // 5-calendar-day window from Thursday 9:13 AM ET ended Tuesday morning and
    // never saw Tuesday's or Wednesday's sessions.
    const thursdayMorning = Date.UTC(2026, 8, 3, 13, 13, 0); // 2026-09-03T13:13Z
    const [w] = availabilityWindows(thursdayMorning, {
      windows: 1,
      spanDays: OFFER_LOOKAHEAD_DAYS,
    });
    const nextWednesdaySession = Date.UTC(2026, 8, 9, 18, 0, 0); // Wed 2 PM ET
    expect(new Date(w.endISO).getTime()).toBeGreaterThan(nextWednesdaySession);
  });

  it("the offer window from the real Pamper Me call (Thu 11:13 AM ET) reaches Tuesday's 2 PM ET session", () => {
    // 2026-09-03T15:13:24Z: the old window ended Tuesday 11:28 AM ET, BEFORE
    // Tuesday's 2 PM session, so the agent was offered only "today" and a lead
    // who asked for Tuesday got booked for today.
    const realCall = Date.UTC(2026, 8, 3, 15, 13, 24);
    const [w] = availabilityWindows(realCall, {
      windows: 1,
      spanDays: OFFER_LOOKAHEAD_DAYS,
    });
    const tuesdaySession = Date.UTC(2026, 8, 8, 18, 0, 0); // Tue 2 PM ET
    expect(new Date(w.endISO).getTime()).toBeGreaterThan(tuesdaySession);
  });
});

describe("OFFER_LOOKAHEAD_DAYS", () => {
  it("is 7 days: reaches the 4th business day's session from any weekday call, inside one Calendly query", () => {
    expect(OFFER_LOOKAHEAD_DAYS).toBe(7);
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

  it("says 'next <Weekday>' when the slot shares today's weekday a week out, bare weekday inside that", () => {
    // Thursday 2026-09-03, 3 PM in New York (19:00Z). With a 7-day window the
    // agent can see NEXT Thursday's 2 PM session, so "Thursday" alone would be
    // ambiguous with today.
    const thursdayAfternoon = Date.UTC(2026, 8, 3, 19, 0, 0);
    expect(
      relativeDayLabel(
        "2026-09-10T18:00:00Z",
        thursdayAfternoon,
        "America/New_York",
      ),
    ).toBe("next Thursday");
    // Six days out is still unambiguous: just "Wednesday".
    expect(
      relativeDayLabel(
        "2026-09-09T18:00:00Z",
        thursdayAfternoon,
        "America/New_York",
      ),
    ).toBe("Wednesday");
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

describe("pickBookingPhone", () => {
  // Marija, 2026-09-10: the cell the lead gives on the call goes into Calendly's
  // Phone Number question; if they don't give one, the lead's business number does.
  const businessPhone = "+19075551234";

  it("uses the cell the lead gave, normalised to E.164", () => {
    expect(
      pickBookingPhone({ mobile: "(813) 555-0123", businessPhone }),
    ).toEqual({
      phone: "+18135550123",
      source: "mobile",
      mobileInvalid: false,
    });
    expect(pickBookingPhone({ mobile: "+18135550123", businessPhone })).toEqual(
      {
        phone: "+18135550123",
        source: "mobile",
        mobileInvalid: false,
      },
    );
    expect(
      pickBookingPhone({ mobile: "1-813-555-0123", businessPhone }),
    ).toEqual({
      phone: "+18135550123",
      source: "mobile",
      mobileInvalid: false,
    });
    expect(
      pickBookingPhone({ mobile: "+(1) 813-555-0123", businessPhone }),
    ).toEqual({
      phone: "+18135550123",
      source: "mobile",
      mobileInvalid: false,
    });
  });

  it("falls back to the business number when no cell was given", () => {
    for (const mobile of [undefined, null, "", "   ", "N/A", "none"]) {
      expect(pickBookingPhone({ mobile, businessPhone })).toEqual({
        phone: businessPhone,
        source: "business",
        mobileInvalid: false,
      });
    }
  });

  it("falls back to the business number when the cell was misheard, and flags it", () => {
    // Partial numbers, foreign numbers (even one whose digits total ten) and
    // impossible NANP numbers (area code or exchange starting with 0 or 1) are
    // never sent: the business number goes in instead. "+8135550123" (a US
    // cell with the 1 dropped) is deliberately read as foreign: +81 is Japan.
    for (const mobile of [
      "813 555",
      "+44 20 7946 0958",
      "+354 611 1234",
      "123-456-7890",
      "023-456-7890",
      "813-055-0123",
      "813-155-0123",
      "+8135550123",
      " +354 611 1234",
    ]) {
      expect(pickBookingPhone({ mobile, businessPhone })).toEqual({
        phone: businessPhone,
        source: "business",
        mobileInvalid: true,
      });
    }
  });

  it("normalises the business number too, and drops an impossible one", () => {
    expect(
      pickBookingPhone({ mobile: undefined, businessPhone: "(907) 555-1234" }),
    ).toEqual({
      phone: "+19075551234",
      source: "business",
      mobileInvalid: false,
    });
    expect(
      pickBookingPhone({ mobile: undefined, businessPhone: "+11234567890" }),
    ).toEqual({ phone: null, source: null, mobileInvalid: false });
  });

  it("returns no phone when neither number is usable", () => {
    expect(pickBookingPhone({ mobile: null, businessPhone: null })).toEqual({
      phone: null,
      source: null,
      mobileInvalid: false,
    });
    expect(pickBookingPhone({ mobile: "12", businessPhone: "12345" })).toEqual({
      phone: null,
      source: null,
      mobileInvalid: true,
    });
  });
});

describe("requiredQuestionPhone", () => {
  // Before this feature, a REQUIRED phone_number question always got the raw
  // business number. pickBookingPhone only returns a NANP-shaped number, so a
  // business number that is merely foreign or malformed (not unusable, just
  // unvalidated) must still reach a REQUIRED question.
  const lead = { business_phone: "+44 20 7946 0958", owner_phone: null };
  const requiredPhoneQ: CalendlyCustomQuestion = {
    name: "Phone Number",
    type: "phone_number",
    position: 0,
    required: true,
    enabled: true,
    answer_choices: [],
  };

  it("keeps the raw business number for a REQUIRED question when it fails the NANP check, instead of leaking the company name in", () => {
    const bookingPhone = pickBookingPhone({
      mobile: undefined,
      businessPhone: lead.business_phone,
    });
    const phone = requiredQuestionPhone(bookingPhone, lead);
    // Fed into buildQuestionsAndAnswers exactly as bookAppointment does.
    expect(
      buildQuestionsAndAnswers([requiredPhoneQ], {
        company: "Acme Dental",
        name: "Jamie",
        email: "jamie@acmedental.example",
        phone,
      }),
    ).toEqual([
      { question: "Phone Number", answer: "+44 20 7946 0958", position: 0 },
    ]);
  });

  it("still lets a valid cell win over the business number", () => {
    const bookingPhone = pickBookingPhone({
      mobile: "813-555-0123",
      businessPhone: "+19075551234",
    });
    expect(requiredQuestionPhone(bookingPhone, lead)).toBe("+18135550123");
  });
});

describe("buildOptionalPhoneAnswer", () => {
  // The live webinar form, read from Calendly on 2026-09-10.
  const liveForm: CalendlyCustomQuestion[] = [
    {
      name: "Company Name",
      type: "string",
      position: 0,
      required: true,
      enabled: true,
      answer_choices: [],
    },
    {
      name: "Phone Number",
      type: "phone_number",
      position: 1,
      required: false,
      enabled: true,
      answer_choices: [],
    },
  ];
  const phone = "+18135550123";

  it("answers the form's optional Phone Number question, text copied exactly", () => {
    expect(buildOptionalPhoneAnswer(liveForm, phone)).toEqual({
      question: "Phone Number",
      answer: phone,
      position: 1,
    });
  });

  it("returns null when there is no phone to give", () => {
    expect(buildOptionalPhoneAnswer(liveForm, null)).toBeNull();
    expect(buildOptionalPhoneAnswer(liveForm, "")).toBeNull();
    expect(buildOptionalPhoneAnswer(liveForm, "   ")).toBeNull();
  });

  it("trims surrounding whitespace from the phone before returning it", () => {
    expect(buildOptionalPhoneAnswer(liveForm, `  ${phone}  `)).toEqual({
      question: "Phone Number",
      answer: phone,
      position: 1,
    });
  });

  it("leaves a REQUIRED phone question to buildQuestionsAndAnswers", () => {
    const qs: CalendlyCustomQuestion[] = [{ ...liveForm[1], required: true }];
    expect(buildOptionalPhoneAnswer(qs, phone)).toBeNull();
  });

  it("never answers other optional questions, since a wrong answer can reject the booking", () => {
    const qs: CalendlyCustomQuestion[] = [
      {
        name: "Which best describes you?",
        type: "single_select",
        position: 0,
        required: false,
        enabled: true,
        answer_choices: ["Current Referrizer client", "New to Referrizer"],
      },
      {
        name: "Can we text your cell?",
        type: "single_select",
        position: 1,
        required: false,
        enabled: true,
        answer_choices: ["Yes", "No"],
      },
      {
        name: "Anything you'd like us to cover?",
        type: "text",
        position: 2,
        required: false,
        enabled: true,
        answer_choices: [],
      },
    ];
    expect(buildOptionalPhoneAnswer(qs, phone)).toBeNull();
  });

  it("ignores free-text questions that only mention a phone (the webinar is about phones)", () => {
    // Deliberate: only Calendly's phone_number type is filled. A wording match
    // would overwrite an answer like the phone system with a phone number.
    const qs: CalendlyCustomQuestion[] = [
      {
        name: "What phone system do you use today?",
        type: "text",
        position: 0,
        required: false,
        enabled: true,
        answer_choices: [],
      },
      {
        name: "How many phone calls do you miss per week?",
        type: "string",
        position: 1,
        required: false,
        enabled: true,
        answer_choices: [],
      },
      {
        name: "Best cell for reminders",
        type: "string",
        position: 2,
        required: false,
        enabled: true,
        answer_choices: [],
      },
    ];
    expect(buildOptionalPhoneAnswer(qs, phone)).toBeNull();
  });

  it("finds the phone_number question even when a phone-worded question comes first", () => {
    const qs: CalendlyCustomQuestion[] = [
      liveForm[0],
      {
        name: "What phone system do you use today?",
        type: "text",
        position: 1,
        required: false,
        enabled: true,
        answer_choices: [],
      },
      { ...liveForm[1], position: 2 },
    ];
    expect(buildOptionalPhoneAnswer(qs, phone)).toEqual({
      question: "Phone Number",
      answer: phone,
      position: 2,
    });
  });

  it("falls back to the question's place in the list when Calendly sends no position", () => {
    const qs: CalendlyCustomQuestion[] = [
      liveForm[0],
      { ...liveForm[1], position: null },
    ];
    expect(buildOptionalPhoneAnswer(qs, phone)).toEqual({
      question: "Phone Number",
      answer: phone,
      position: 1,
    });
  });

  it("skips a disabled phone question", () => {
    const qs: CalendlyCustomQuestion[] = [{ ...liveForm[1], enabled: false }];
    expect(buildOptionalPhoneAnswer(qs, phone)).toBeNull();
  });

  it("returns null when the event type has no questions", () => {
    expect(buildOptionalPhoneAnswer([], phone)).toBeNull();
    expect(buildOptionalPhoneAnswer(null, phone)).toBeNull();
    expect(buildOptionalPhoneAnswer(undefined, phone)).toBeNull();
  });
});

describe("bookingPhoneAudit", () => {
  const businessPhone = "+19075551234";

  it("records a cell the lead gave", () => {
    const bookingPhone = pickBookingPhone({
      mobile: "813-555-0123",
      businessPhone,
    });
    expect(
      bookingPhoneAudit({
        bookingPhone,
        rawMobile: "813-555-0123",
        leadMobilePhone: null,
      }),
    ).toEqual({ phone_source: "mobile" });
  });

  it("records the old cell when a booking replaces a different one on the lead", () => {
    const bookingPhone = pickBookingPhone({
      mobile: "+18135550123",
      businessPhone,
    });
    expect(
      bookingPhoneAudit({
        bookingPhone,
        rawMobile: "+18135550123",
        leadMobilePhone: "+19075550000",
      }),
    ).toEqual({
      phone_source: "mobile",
      mobile_phone_replaced: "+19075550000",
    });
    expect(
      bookingPhoneAudit({
        bookingPhone,
        rawMobile: "+18135550123",
        leadMobilePhone: "+18135550123",
      }),
    ).toEqual({ phone_source: "mobile" });
  });

  it("flags a misheard cell and keeps what was passed", () => {
    const bookingPhone = pickBookingPhone({ mobile: "813 555", businessPhone });
    expect(
      bookingPhoneAudit({
        bookingPhone,
        rawMobile: "813 555",
        leadMobilePhone: null,
      }),
    ).toEqual({
      phone_source: "business",
      mobile_invalid: true,
      mobile_unused: "813 555",
    });
  });

  it("keeps a placeholder or spelled-out cell as unused without calling it misheard", () => {
    for (const rawMobile of ["N/A", "eight one three five five five"]) {
      const bookingPhone = pickBookingPhone({
        mobile: rawMobile,
        businessPhone,
      });
      expect(
        bookingPhoneAudit({ bookingPhone, rawMobile, leadMobilePhone: null }),
      ).toEqual({ phone_source: "business", mobile_unused: rawMobile });
    }
  });

  it("records only the source when no cell was passed", () => {
    const bookingPhone = pickBookingPhone({ mobile: "", businessPhone });
    expect(
      bookingPhoneAudit({
        bookingPhone,
        rawMobile: "",
        leadMobilePhone: "+18135550123",
      }),
    ).toEqual({ phone_source: "business" });
    const none = pickBookingPhone({ mobile: "", businessPhone: null });
    expect(
      bookingPhoneAudit({
        bookingPhone: none,
        rawMobile: "",
        leadMobilePhone: null,
      }),
    ).toEqual({ phone_source: null });
  });
});

describe("bookingPhoneOutcome", () => {
  const phone = "+18135550123";
  const bookingPhone = pickBookingPhone({
    mobile: phone,
    businessPhone: "+19075551234",
  });
  const companyQ: CalendlyCustomQuestion = {
    name: "Company Name",
    type: "string",
    position: 0,
    required: true,
    enabled: true,
    answer_choices: [],
  };
  const optionalPhoneQ: CalendlyCustomQuestion = {
    name: "Phone Number",
    type: "phone_number",
    position: 1,
    required: false,
    enabled: true,
    answer_choices: [],
  };
  const liveForm = [companyQ, optionalPhoneQ];
  const liveAnswer = buildOptionalPhoneAnswer(liveForm, phone);

  const outcome = (over: Partial<Parameters<typeof bookingPhoneOutcome>[0]>) =>
    bookingPhoneOutcome({
      bookingPhone,
      optionalAnswer: liveAnswer,
      questions: liveForm,
      leadIsDnc: false,
      dncLookup: "clear",
      ...over,
    });

  it("sends the optional phone when the number is clear", () => {
    expect(outcome({})).toEqual({ optionalAnswer: liveAnswer, audit: {} });
  });

  it("drops it when the number is on the owner's do-not-call list", () => {
    expect(outcome({ dncLookup: "listed" })).toEqual({
      optionalAnswer: null,
      audit: { phone_dnc: true },
    });
  });

  it("drops it when the lead itself is do-not-call", () => {
    expect(outcome({ leadIsDnc: true, dncLookup: null })).toEqual({
      optionalAnswer: null,
      audit: { phone_dnc: true },
    });
  });

  it("fails closed: an unreadable list (or no lookup) is never treated as clear", () => {
    expect(outcome({ dncLookup: "unknown" })).toEqual({
      optionalAnswer: null,
      audit: { phone_dnc_unchecked: true },
    });
    expect(outcome({ dncLookup: null })).toEqual({
      optionalAnswer: null,
      audit: { phone_dnc_unchecked: true },
    });
  });

  it("flags a form with no phone_number question to carry the phone", () => {
    // Judged by question type, not answer values: an inbound-created lead's
    // company can equal its phone number.
    expect(outcome({ optionalAnswer: null, questions: [companyQ] })).toEqual({
      optionalAnswer: null,
      audit: { phone_unanswered: true },
    });
  });

  it("a REQUIRED phone_number question carries the phone: not unanswered, and a DNC number there is only flagged", () => {
    const requiredForm = [companyQ, { ...optionalPhoneQ, required: true }];
    expect(outcome({ optionalAnswer: null, questions: requiredForm })).toEqual({
      optionalAnswer: null,
      audit: {},
    });
    expect(
      outcome({
        optionalAnswer: null,
        questions: requiredForm,
        dncLookup: "listed",
      }),
    ).toEqual({ optionalAnswer: null, audit: { phone_dnc_required: true } });
    // An UNVERIFIABLE number (an unreadable list, or no lookup at all) is sent
    // too, same as a listed one: skipping a REQUIRED question would fail the
    // whole booking either way, so it is only ever flagged, never dropped.
    expect(
      outcome({
        optionalAnswer: null,
        questions: requiredForm,
        dncLookup: "unknown",
      }),
    ).toEqual({ optionalAnswer: null, audit: { phone_dnc_required: true } });
    expect(
      outcome({
        optionalAnswer: null,
        questions: requiredForm,
        dncLookup: null,
      }),
    ).toEqual({ optionalAnswer: null, audit: { phone_dnc_required: true } });
  });

  it.each(["listed", "unknown"] as const)(
    "phone_unanswered is judged by question TYPE alone, never do-not-call status — still flagged when the number is %s",
    (dncLookup) => {
      expect(
        outcome({ optionalAnswer: null, questions: [companyQ], dncLookup }),
      ).toEqual({ optionalAnswer: null, audit: { phone_unanswered: true } });
    },
  );

  it("known gap: a REQUIRED free-text 'Phone' question is recognised by its TYPE, not its name, so it still reads as unanswered", () => {
    const wordedForm: CalendlyCustomQuestion[] = [
      companyQ,
      {
        name: "Phone",
        type: "string",
        position: 1,
        required: true,
        enabled: true,
        answer_choices: [],
      },
    ];
    expect(
      outcome({
        optionalAnswer: null,
        questions: wordedForm,
        dncLookup: "listed",
      }),
    ).toEqual({ optionalAnswer: null, audit: { phone_unanswered: true } });
  });

  it("does nothing when there is no phone at all", () => {
    const none = pickBookingPhone({ mobile: "", businessPhone: null });
    expect(
      bookingPhoneOutcome({
        bookingPhone: none,
        optionalAnswer: null,
        questions: liveForm,
        leadIsDnc: true,
        dncLookup: null,
      }),
    ).toEqual({ optionalAnswer: null, audit: {} });
  });
});

describe("isSlotGoneError", () => {
  it.each([
    "start_time That start time has been filled",
    "That time is unavailable",
    "start_time is no longer available",
    "The event is at capacity",
  ])("treats %j as the time being gone", (detail) => {
    expect(isSlotGoneError(detail)).toBe(true);
  });

  it.each([
    "questions_and_answers Phone Number is not a valid phone number",
    "Required Questions and Answers cannot be blank.",
    "invitee either name or first_name must be filled",
    "Calendly booking failed (500).",
  ])("does not treat %j as the time being gone", (detail) => {
    expect(isSlotGoneError(detail)).toBe(false);
  });

  it("is false for no error", () => {
    expect(isSlotGoneError(null)).toBe(false);
    expect(isSlotGoneError(undefined)).toBe(false);
  });
});
