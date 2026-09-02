/**
 * Pure helpers for Calendly booking. Kept free of the `server-only` import and
 * of any live fetch so they unit-test cleanly; the live API calls that use them
 * live in ./api.ts.
 */

/** One entry of a Calendly event type's `locations` array (GET /event_types).
 *  We only care about `kind`; the other fields vary by location type. */
export type CalendlyLocation = { kind?: string | null };

/**
 * The `location` object to include in a POST /invitees booking. Calendly
 * REQUIRES it whenever the event type specifies a location and rejects the
 * booking otherwise (`event.location_configuration.kind invalid location
 * choice`) — the bug that silently broke every Zoom/Meet/phone event. For
 * host-defined locations (Zoom, Google Meet, Teams, Webex, GoTo, a host
 * physical address) the invitee just echoes the kind back. Returns undefined
 * when the event type has no location, in which case the field MUST be omitted.
 */
export function buildInviteeLocation(
  locations: CalendlyLocation[] | null | undefined,
): { kind: string } | undefined {
  const kind = locations?.[0]?.kind;
  return typeof kind === "string" && kind.length > 0 ? { kind } : undefined;
}

export type AvailabilityWindow = { startISO: string; endISO: string };

/**
 * How far ahead get_available_times looks when offering the lead a session.
 *
 * Deliberately SHORT. The daily webinar's Calendly event only lets invitees
 * book ~4 days out (the host's choice: a seat booked weeks ahead is a seat
 * nobody shows up for), so anything past that comes back empty from Calendly
 * anyway. Five days covers the host's range with a day to spare and keeps the
 * list the agent has to hold to a handful of lines — ONE tool call, and no dead
 * air on the phone while it re-checks a day the owner named. Calendly stays the
 * source of truth: shrinking or growing its range needs no change here unless
 * it passes five days.
 *
 * NOT used for a fixed-time (single-session) event — see soonestCalendlyOpening
 * in the tool webhook, which keeps the long forward scan so a one-off date
 * weeks out is still found.
 */
export const OFFER_LOOKAHEAD_DAYS = 5;

/**
 * Forward-scan windows for Calendly's event_type_available_times endpoint,
 * which caps each query at a 7-day span. By default these cover ~6 weeks (a
 * fixed webinar date two weeks out was once missed by a 6-day look-ahead), are
 * gap-free (each window's length equals the step) and each span stays safely
 * under 7 days. `spanDays` shortens a window for callers that only want the
 * next few days (see OFFER_LOOKAHEAD_DAYS).
 */
export function availabilityWindows(
  nowMs: number,
  opts?: { windows?: number; leadMinutes?: number; spanDays?: number },
): AvailabilityWindow[] {
  const windows = Math.max(1, opts?.windows ?? 6);
  const leadMinutes = opts?.leadMinutes ?? 15;
  // 6.9 days by default: under Calendly's 7-day cap, and reused as the step so
  // consecutive windows abut with no gap between them. A caller-supplied span
  // is clamped to the same cap.
  const spanDays = Math.min(6.9, Math.max(0.1, opts?.spanDays ?? 6.9));
  const SPAN_MS = Math.floor(spanDays * 24 * 60 * 60 * 1000);
  const base = nowMs + leadMinutes * 60 * 1000;
  const out: AvailabilityWindow[] = [];
  for (let i = 0; i < windows; i++) {
    const start = base + i * SPAN_MS;
    out.push({
      startISO: new Date(start).toISOString(),
      endISO: new Date(start + SPAN_MS).toISOString(),
    });
  }
  return out;
}

/**
 * How a person would refer to a slot's day, relative to the lead's own today:
 * "today", "tomorrow", or the weekday name ("Thursday"). Computed in the LEAD's
 * timezone — late in a Pacific evening, a session on the lead's tomorrow is
 * already "today" in UTC, and the agent must say what the owner would say.
 * Only meaningful inside a short look-ahead (see OFFER_LOOKAHEAD_DAYS): within
 * five days a weekday name can never be ambiguous, which is what lets the agent
 * skip "this Thursday or next?" entirely. Empty string for an unparseable time.
 */
export function relativeDayLabel(
  slotISO: string,
  nowMs: number,
  timeZone: string | null | undefined,
): string {
  const tz = timeZone || "America/New_York";
  const slot = new Date(slotISO);
  if (Number.isNaN(slot.getTime())) return "";
  // Whole days since the epoch, as counted on the lead's local calendar.
  const localDayNumber = (d: Date): number => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(d);
    const get = (type: string) =>
      Number(parts.find((p) => p.type === type)?.value ?? 0);
    return Math.floor(
      Date.UTC(get("year"), get("month") - 1, get("day")) / 86_400_000,
    );
  };
  const diff = localDayNumber(slot) - localDayNumber(new Date(nowMs));
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  return slot.toLocaleDateString("en-US", { weekday: "long", timeZone: tz });
}

/** The tracking fields Calendly stores on a booking (its invitee `tracking`
 *  object). Calendly's Create Invitee API treats this object as ALL-OR-NOTHING:
 *  once you send `tracking` at all, EVERY field must be present, or it rejects
 *  the booking with "utm_content/utm_term/salesforce_uuid is missing" — even
 *  though nobody marked them required in the event settings. So every field is
 *  non-optional here. (`salesforce_uuid` is just a free tracking token per
 *  Calendly's docs — "a userID or anything else you need to track" — no
 *  Salesforce involved.) */
export type CalendlyTracking = {
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  salesforce_uuid: string;
};

/**
 * Normalise an operator-typed UTM campaign value into something Calendly and
 * ad-platform reporting group cleanly: lower-case, whitespace → underscores,
 * only [a-z0-9_-], max 100 chars (the DB check constraint enforces the same
 * shape). Returns "" when nothing usable is left, so callers can `||` through
 * to their fallback. Pure, unit-tested.
 */
export function normalizeUtmCampaign(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 100);
}

/** LEGACY per-campaign booking attribution, keyed by campaign id. Superseded
 *  on 2026-09-02 by the per-campaign `booking_utm_campaign` setting (campaign
 *  settings dialog → "Booking UTM campaign"), which bookingTracking checks
 *  FIRST. Kept only so any campaign still relying on it keeps tagging.
 *  Mirrors CAMPAIGN_LINK_UTM in ../shortlinks/destination.
 *
 *  ⚠️ The sharp edge that motivated the setting: a database reset recreates the
 *  campaign with a NEW id and this silently stops matching — bookings still
 *  tag, just with the fallback (campaign name). Prefer the setting. */
const CAMPAIGN_BOOKING_UTM: Record<
  string,
  { source: string; campaign: string }
> = {
  // The currently-active webinar campaign. Repointed 2026-08-18 when Smile & Dial
  // moved to its own ElevenLabs workspace: the prior Reason First (29ea2566) and
  // Pattern Interrupt (9d1908ab) campaigns were ended and their footprint merged
  // into this one, which took a NEW id — so the old entries stopped matching.
  // HireAI Webinar Invite
  "3cd40c9c-5a42-4476-9ef1-c6a1e0fc72d8": {
    source: "smile_dial",
    campaign: "voice_ai_webinar_27",
  },
};

/**
 * The attribution to stamp on a Calendly booking (the invitee `tracking` object
 * in POST /invitees). Bookings always come from an AI phone call, so
 * `utm_medium` is fixed to "voice". `utm_source` defaults to "smile_dial" and
 * `utm_campaign` to the campaign's own name; a campaign in CAMPAIGN_BOOKING_UTM
 * overrides both.
 *
 * Every field is filled with a non-empty value because Calendly rejects a
 * PARTIAL tracking object (see CalendlyTracking). `utm_content` carries the
 * campaign again so each variant (e.g. AI-disclosure A/B) is distinguishable in
 * reporting; `utm_term` is a stable channel tag; `salesforce_uuid` is the lead
 * id — a unique per-booking token, no Salesforce needed. Pure, so unit-tested.
 */
export function bookingTracking(args: {
  campaignId: string | null;
  campaignName: string | null;
  leadId: string;
  /** The campaign's own "Booking UTM campaign" setting
   *  (campaigns.booking_utm_campaign). When set it wins over the legacy id map
   *  and the campaign name — it is the operator's explicit, per-campaign
   *  answer to "what should these bookings be tagged as", and unlike the map
   *  it survives the campaign being recreated. */
  bookingUtmCampaign?: string | null;
}): CalendlyTracking {
  const override = args.campaignId
    ? CAMPAIGN_BOOKING_UTM[args.campaignId]
    : undefined;
  const configured = normalizeUtmCampaign(args.bookingUtmCampaign);
  const campaign =
    configured || override?.campaign || args.campaignName || "voice_ai";
  return {
    utm_source: override?.source ?? "smile_dial",
    utm_medium: "voice",
    utm_campaign: campaign,
    utm_content: campaign,
    utm_term: "voice_ai",
    salesforce_uuid: args.leadId,
  };
}

/** One entry of a Calendly event type's `custom_questions` array
 *  (GET /event_types/{uuid}). These are the extra fields the HOST added to the
 *  booking form — they live entirely in the host's Calendly account, so they can
 *  appear or become required at any time without any change on our side. */
export type CalendlyCustomQuestion = {
  name?: string | null;
  /** "string" | "text" | "phone_number" | "single_select" | "multi_select" | … */
  type?: string | null;
  position?: number | null;
  required?: boolean | null;
  enabled?: boolean | null;
  answer_choices?: string[] | null;
};

/** The lead facts we can answer a booking question with. */
export type BookingFacts = {
  company?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
};

export type CalendlyQuestionAnswer = {
  question: string;
  answer: string;
  position: number;
};

const firstNonBlank = (...vals: (string | null | undefined)[]): string => {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
  return "";
};

/** Pick a valid option for a select question. Calendly rejects any answer that
 *  isn't one of `answer_choices`, so we must choose from the list. We bias to a
 *  "new / prospect / none" style option because every lead we dial is a cold
 *  prospect — defaulting to the first choice would stamp them as an existing
 *  customer and poison the host's reporting. */
const pickChoice = (choices: string[]): string =>
  choices.find((c) =>
    /\bnew\b|prospect|none|other|not\s+(yet\s+)?a\b/i.test(c),
  ) ?? choices[0];

/**
 * Build the `questions_and_answers` payload for POST /invitees.
 *
 * Why this exists: on 2026-08-18 the webinar's Calendly form gained a REQUIRED
 * "Company name" question. We sent no answers, so Calendly rejected every
 * booking with "Required Questions and Answers cannot be blank." — a 100%
 * booking outage that surfaced to the caller as "that time just became
 * unavailable". The host owns that form, so we must answer whatever it asks
 * rather than assume a fixed shape.
 *
 * Rules:
 *  - Answer only ENABLED + REQUIRED questions. An optional question is left
 *    blank on purpose: a wrong select value gets the whole booking rejected,
 *    and a booking matters far more than an extra field.
 *  - Never emit a blank answer — blank is exactly what Calendly refuses.
 *  - `question` must match the host's wording EXACTLY (Calendly compares it
 *    case-sensitively), so it is echoed through untouched.
 */
export function buildQuestionsAndAnswers(
  questions: CalendlyCustomQuestion[] | null | undefined,
  facts: BookingFacts,
): CalendlyQuestionAnswer[] {
  const { company, name, email, phone } = facts;
  // Last-resort filler: a required question we can't map still must not be
  // blank. The company is the most useful thing a host could want.
  const fallback = firstNonBlank(company, name, email, phone, "Not provided");

  const out: CalendlyQuestionAnswer[] = [];
  for (const q of questions ?? []) {
    const question = typeof q?.name === "string" ? q.name : "";
    if (!question) continue;
    if (q.enabled === false) continue;
    if (q.required !== true) continue;

    const choices = (q.answer_choices ?? []).filter(
      (c): c is string => typeof c === "string" && c.trim().length > 0,
    );
    const type = (q.type ?? "").toLowerCase();
    const asks = (re: RegExp) => re.test(question);

    let answer: string;
    if (choices.length > 0 || type.includes("select")) {
      // A select with no usable choices can't be answered safely; skipping it
      // loses this booking, but inventing a value loses it too AND corrupts the
      // host's data.
      if (choices.length === 0) continue;
      answer = pickChoice(choices);
    } else if (type === "phone_number" || asks(/phone|mobile|cell/i)) {
      answer = firstNonBlank(phone, fallback);
    } else if (asks(/e-?mail/i)) {
      answer = firstNonBlank(email, fallback);
    } else if (
      // Checked BEFORE the plain /name/ test — "Company name" matches both and
      // must resolve to the company.
      asks(
        /company|business|practice|studio|salon|clinic|shop|firm|brand|organi[sz]ation/i,
      )
    ) {
      answer = firstNonBlank(company, fallback);
    } else if (asks(/name/i)) {
      answer = firstNonBlank(name, fallback);
    } else {
      answer = fallback;
    }

    if (!answer.trim()) continue;
    out.push({
      question,
      answer,
      position: typeof q.position === "number" ? q.position : out.length,
    });
  }
  return out;
}
