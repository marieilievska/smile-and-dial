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
 * Forward-scan windows for Calendly's event_type_available_times endpoint,
 * which caps each query at a 7-day span. Looking only ~6 days ahead (the old
 * behaviour) missed a fixed webinar date two weeks out, so the tool fell back
 * to inventing generic slots. These windows cover ~6 weeks, are gap-free (each
 * window's length equals the step) and each span stays safely under 7 days.
 */
export function availabilityWindows(
  nowMs: number,
  opts?: { windows?: number; leadMinutes?: number },
): AvailabilityWindow[] {
  const windows = Math.max(1, opts?.windows ?? 6);
  const leadMinutes = opts?.leadMinutes ?? 15;
  // 6.9 days: under Calendly's 7-day cap, and reused as the step so consecutive
  // windows abut with no gap between them.
  const SPAN_MS = Math.floor(6.9 * 24 * 60 * 60 * 1000);
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

/** Per-campaign booking attribution, keyed by campaign id (an id survives a
 *  rename; a name doesn't). Mirrors CAMPAIGN_LINK_UTM in ../shortlinks/destination.
 *
 *  ⚠️ Same sharp edge as the link map: a database reset recreates the campaign
 *  with a NEW id and this silently stops matching — bookings still tag, just with
 *  the fallback (campaign name) instead of the intended `utm_campaign`. If the
 *  Calendly report stops showing `voice_ai_webinar`, check this id first. */
const CAMPAIGN_BOOKING_UTM: Record<
  string,
  { source: string; campaign: string }
> = {
  // The two currently-active webinar campaigns (A/B variants). The prior single
  // id (17a7a2e8, pre-reset "HireAI Webinar") no longer matched any campaign, so
  // bookings were silently falling back to the campaign name — updated 2026-08-11.
  // HireAI Webinar Reason First
  "29ea2566-c6df-4f96-a6d5-65ebbb16fbda": {
    source: "smile_dial",
    campaign: "voice_ai_webinar",
  },
  // HireAI Webinar Pattern Interrupt
  "9d1908ab-638a-440f-8dc8-016cb2b2534a": {
    source: "smile_dial",
    campaign: "voice_ai_webinar",
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
}): CalendlyTracking {
  const override = args.campaignId
    ? CAMPAIGN_BOOKING_UTM[args.campaignId]
    : undefined;
  const campaign = override?.campaign ?? args.campaignName ?? "voice_ai";
  return {
    utm_source: override?.source ?? "smile_dial",
    utm_medium: "voice",
    utm_campaign: campaign,
    utm_content: campaign,
    utm_term: "voice_ai",
    salesforce_uuid: args.leadId,
  };
}
