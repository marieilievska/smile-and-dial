/**
 * Pure helpers for Calendly booking. Kept free of the `server-only` import and
 * of any live fetch so they unit-test cleanly; the live API calls that use them
 * live in ./api.ts.
 */

import { toE164UsCa } from "@/lib/leads/twilio-lookup";

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
 * Deliberately SHORT — one Calendly query, a handful of lines for the agent to
 * hold, no dead air re-checking a day the owner named. But it must reach every
 * session the host actually lets people book. The daily webinar runs weekdays
 * at 2 PM ET and its Calendly booking range counts BUSINESS days (~4): from a
 * Thursday that is next WEDNESDAY, six calendar days out. The old 5-day window
 * from a Thursday 11:13 AM ET call ended Tuesday 11:28 AM — before Tuesday's
 * 2 PM session — so the agent was offered only "today", and a lead who asked
 * for Tuesday was booked for today (the "Pamper Me Skin Care" mis-booking).
 * Seven days reaches the 4th business day's 2 PM session from any weekday
 * call and is exactly the largest span one Calendly query accepts (verified
 * live 2026-09-03). Calendly stays the source of truth for what is bookable.
 *
 * NOT used for a fixed-time (single-session) event — see soonestCalendlyOpening
 * in the tool webhook, which keeps the long forward scan so a one-off date
 * weeks out is still found.
 */
export const OFFER_LOOKAHEAD_DAYS = 7;

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
  // 6.9 days by default: safely under Calendly's 7-day cap for the multi-window
  // forward scan, and reused as the step so consecutive windows abut with no
  // gap between them. A caller-supplied span is clamped to exactly 7 days —
  // Calendly accepts a 7.0-day query (verified live 2026-09-03), and the
  // single-window daily-webinar offer needs the full week (OFFER_LOOKAHEAD_DAYS).
  const spanDays = Math.min(7, Math.max(0.1, opts?.spanDays ?? 6.9));
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
 * "today", "tomorrow", the weekday name ("Thursday"), or "next Thursday" once
 * the slot is a full week out. Computed in the LEAD's timezone — late in a
 * Pacific evening, a session on the lead's tomorrow is already "today" in UTC,
 * and the agent must say what the owner would say. Only meaningful inside a
 * short look-ahead (see OFFER_LOOKAHEAD_DAYS): two to six days out a weekday
 * name is unambiguous, which lets the agent skip "this Thursday or next?". At
 * seven days the slot shares TODAY's weekday (a Thursday 3 PM call sees next
 * Thursday's 2 PM session), so it is labelled "next <Weekday>" to keep the two
 * apart. Empty string for an unparseable time.
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
  const weekday = slot.toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: tz,
  });
  return diff >= 7 ? `next ${weekday}` : weekday;
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

/** Where the phone on a booking came from. Logged on every live booking, so
 *  "how often do leads give a cell?" can be read from the audit trail. */
export type BookingPhoneSource = "mobile" | "business";

/** The phone chosen for a booking. `mobileInvalid` is true when a cell was
 *  passed but wasn't a usable US/Canada number (misheard, partial or foreign),
 *  so it wasn't used: the business number was, if that one is usable. */
export type BookingPhone =
  | { phone: string; source: BookingPhoneSource; mobileInvalid: boolean }
  | { phone: null; source: null; mobileInvalid: boolean };

/** A US/Canada number in E.164 with a possible NANP shape (area code and
 *  exchange can't start with 0 or 1), or null. A best-effort shape check: it
 *  can't know whether an area code is actually in service. toE164UsCa already
 *  rejects an explicit non-+1 country code (#518), so this needs no
 *  foreign-number guard of its own. */
function toBookableUsCaPhone(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const e164 = toE164UsCa(raw);
  return e164 && /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(e164) ? e164 : null;
}

/**
 * The number to put in the host's Calendly "Phone Number" question when the AI
 * books. Marija's rule (2026-09-10): the cell the lead gave on the call if
 * there is one, otherwise the lead's business number (the one the dialer
 * calls). A host automation texts that field.
 *
 * Checked HERE, before anything is sent: if a bad cell reached Calendly and was
 * rejected, the retry that drops the answer (createInvitee) would lose the
 * business-number fallback along with it.
 */
export function pickBookingPhone(args: {
  mobile: string | null | undefined;
  businessPhone: string | null | undefined;
}): BookingPhone {
  // A cell counts as "given" only if it has a digit: a placeholder the model
  // sends instead of omitting the field ("N/A", "none") isn't a misheard number.
  const mobileGiven = typeof args.mobile === "string" && /\d/.test(args.mobile);
  const mobile = toBookableUsCaPhone(args.mobile);
  if (mobile) return { phone: mobile, source: "mobile", mobileInvalid: false };
  const business = toBookableUsCaPhone(args.businessPhone);
  if (business) {
    return { phone: business, source: "business", mobileInvalid: mobileGiven };
  }
  return { phone: null, source: null, mobileInvalid: mobileGiven };
}

/**
 * The phone to answer a REQUIRED phone_number question with. Unlike the
 * OPTIONAL question (buildOptionalPhoneAnswer), a REQUIRED one cannot be left
 * blank, so it needs a fallback even when pickBookingPhone found nothing
 * bookable: the raw business number, unvalidated, exactly as it was sent
 * before this feature existed — the plan's promise that an unusable business
 * phone "behaves exactly as before". Without this fallback, a business
 * number that merely fails the NANP/US-CA shape check (foreign, a mistyped
 * extension) left bookingPhone.phone null and owner_phone empty for every
 * lead, so buildQuestionsAndAnswers fell back to the COMPANY NAME and
 * Calendly rejected the booking outright.
 */
export function requiredQuestionPhone(
  bookingPhone: BookingPhone,
  lead: { business_phone: string | null; owner_phone: string | null },
): string | null {
  return bookingPhone.phone || lead.business_phone || lead.owner_phone || null;
}

/**
 * The answer to the host's OPTIONAL phone question (the webinar form's "Phone
 * Number"), or null.
 *
 * buildQuestionsAndAnswers deliberately answers only REQUIRED questions: a
 * wrong answer to an optional question can get the whole booking rejected or
 * corrupt the host's data. The phone is the one optional field we fill on
 * purpose, because the host's reminder texts go to it. A REQUIRED
 * `phone_number` question is skipped HERE and left to buildQuestionsAndAnswers,
 * so it is never answered twice.
 *
 * Only Calendly's own `phone_number` question type counts, never the wording.
 * The webinar is about answering phones, so the host's form can easily hold a
 * question like "What phone system do you use today?", and a wording match
 * would silently overwrite that answer with a number. A free-text "Phone"
 * question therefore stays blank, as it does today.
 *
 * The first enabled optional `phone_number` question wins when a form somehow
 * has more than one.
 */
export function buildOptionalPhoneAnswer(
  questions: CalendlyCustomQuestion[] | null | undefined,
  phone: string | null,
): CalendlyQuestionAnswer | null {
  const answer = phone?.trim();
  if (!answer) return null;
  const list = questions ?? [];
  for (let i = 0; i < list.length; i++) {
    const q = list[i];
    const question = typeof q?.name === "string" ? q.name : "";
    if (!question || q.enabled === false || q.required === true) continue;
    if ((q.type ?? "").toLowerCase() !== "phone_number") continue;
    return {
      question,
      answer: answer,
      position: typeof q.position === "number" ? q.position : i,
    };
  }
  return null;
}

/** What the lead owner's do-not-call lookup said about the booking phone.
 *  "unknown" means the list couldn't be read, which is never treated as clear. */
export type DncLookup = "listed" | "clear" | "unknown";

/** The phone-choice fields logged on every live booking audit. */
export type BookingPhoneAudit = {
  phone_source: BookingPhoneSource | null;
  /** A cell with digits was passed but couldn't be used (misheard, partial or
   *  foreign). */
  mobile_invalid?: boolean;
  /** Whatever the agent passed as `mobile` but wasn't used, including words or
   *  placeholders that mobile_invalid can't see. */
  mobile_unused?: string;
  /** The lead's previous, different mobile_phone that this booking's cell
   *  replaces (e.g. a returning caller's number kept by merge_inbound_lead). */
  mobile_phone_replaced?: string;
};

/**
 * The audit fields describing which phone a booking chose and why. Pure, so
 * the flags that verify this feature in production are pinned by tests.
 */
export function bookingPhoneAudit(args: {
  bookingPhone: BookingPhone;
  /** The trimmed `mobile` the agent passed ("" when none). */
  rawMobile: string;
  /** The lead's mobile_phone before this booking saves a cell. */
  leadMobilePhone: string | null;
}): BookingPhoneAudit {
  const { bookingPhone, rawMobile, leadMobilePhone } = args;
  const audit: BookingPhoneAudit = { phone_source: bookingPhone.source };
  if (bookingPhone.mobileInvalid) audit.mobile_invalid = true;
  if (rawMobile && bookingPhone.source !== "mobile") {
    audit.mobile_unused = rawMobile;
  }
  if (
    bookingPhone.source === "mobile" &&
    leadMobilePhone &&
    leadMobilePhone !== bookingPhone.phone
  ) {
    audit.mobile_phone_replaced = leadMobilePhone;
  }
  return audit;
}

/** Why the phone did or didn't reach Calendly, for the failure/success audits. */
export type BookingPhoneOutcomeAudit = {
  /** The optional phone answer was dropped: the lead or the number is
   *  do-not-call. */
  phone_dnc?: boolean;
  /** The optional phone answer was dropped: the do-not-call list couldn't be
   *  read. */
  phone_dnc_unchecked?: boolean;
  /** A REQUIRED phone_number question still carried a do-not-call or
   *  unverifiable number, because skipping it would fail the booking. */
  phone_dnc_required?: boolean;
  /** A phone was chosen, but the form has no phone_number question to carry it
   *  (e.g. the host turned Phone Number into free text). */
  phone_unanswered?: boolean;
};

/**
 * Applies the do-not-call rule to the booking phone and says why it did or
 * didn't reach Calendly.
 *
 * - Never volunteer an opted-out number to the host's texting automation. The
 *   optional phone answer is dropped when the lead is DNC, the number is on the
 *   owner's list, or the list couldn't be read. That last case fails closed: an
 *   unreadable list must not read as "not on DNC". The booking goes through
 *   either way.
 * - A REQUIRED phone_number question is answered by buildQuestionsAndAnswers
 *   regardless, because skipping it would fail the booking, so that case is
 *   only flagged.
 * - "Unanswered" is judged by question TYPE, not by comparing answer values,
 *   because an inbound-created lead's company can equal its phone number.
 *   Known gap: a required free-text "Phone" question (not the phone_number
 *   type) still carries the number but is reported as unanswered.
 */
export function bookingPhoneOutcome(args: {
  bookingPhone: BookingPhone;
  /** From buildOptionalPhoneAnswer, before the do-not-call rule. */
  optionalAnswer: CalendlyQuestionAnswer | null;
  questions: CalendlyCustomQuestion[] | null | undefined;
  leadIsDnc: boolean;
  /** The owner's dnc_entries lookup for bookingPhone.phone; null when none
   *  ran. */
  dncLookup: DncLookup | null;
}): {
  optionalAnswer: CalendlyQuestionAnswer | null;
  audit: BookingPhoneOutcomeAudit;
} {
  const { bookingPhone, optionalAnswer, questions, leadIsDnc, dncLookup } =
    args;
  if (!bookingPhone.phone) return { optionalAnswer: null, audit: {} };

  const listed = leadIsDnc || dncLookup === "listed";
  // Fail closed: anything but a confirmed "clear" (an error, or no lookup at
  // all) counts as unchecked.
  const unchecked = !listed && dncLookup !== "clear";
  const requiredPhoneQuestion = (questions ?? []).some(
    (q) =>
      typeof q?.name === "string" &&
      q.name.length > 0 &&
      q.enabled !== false &&
      q.required === true &&
      (q.type ?? "").toLowerCase() === "phone_number",
  );

  const audit: BookingPhoneOutcomeAudit = {};
  if (optionalAnswer && listed) audit.phone_dnc = true;
  if (optionalAnswer && unchecked) audit.phone_dnc_unchecked = true;
  if (requiredPhoneQuestion && (listed || unchecked)) {
    audit.phone_dnc_required = true;
  }
  if (!optionalAnswer && !requiredPhoneQuestion) audit.phone_unanswered = true;

  return { optionalAnswer: listed || unchecked ? null : optionalAnswer, audit };
}

/**
 * True when a Calendly booking error means the chosen time is gone (taken, full
 * or past), so the AI should offer another time. Any other failure is a config
 * problem that picking another time can't fix. "has been filled" is Calendly's
 * wording for a full session; it must not match "must be filled"
 * (a missing-field error).
 */
export function isSlotGoneError(detail: string | null | undefined): boolean {
  return /unavailable|already.*(booked|taken)|no longer|invalid start.?time|spot|capacity|full|has been filled/i.test(
    detail ?? "",
  );
}
