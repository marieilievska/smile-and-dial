/** Decides what the in-call Calendly tools (get_available_times and
 *  book_appointment) may DO for a campaign, kept pure so the honesty rule is
 *  unit-tested without Calendly or the database. Mirrors planEmailSend.
 *
 *  - "live"           — the owner connected Calendly AND the campaign chose an
 *                       event → real availability, real booking.
 *  - "disabled"       — Calendly is connected but NO event is chosen: booking
 *                       is intentionally off for this campaign (either mode).
 *  - "mock"           — non-live (dev/test) with no Calendly at all: generic
 *                       demo slots and a pretend confirmation keep the flow
 *                       moving.
 *  - "not_configured" — LIVE with no Calendly (the owner never connected, or
 *                       the call couldn't be resolved to a campaign): refuse
 *                       honestly. On a real call we never invent times the lead
 *                       can't actually book, and never say "Booked" when
 *                       nothing was. */
export type BookingToolPlan = "live" | "disabled" | "mock" | "not_configured";

export function planBookingTool(input: {
  /** process.env.ELEVENLABS_LIVE === "live" */
  live: boolean;
  /** The campaign owner has a Calendly token (false when the call couldn't be
   *  resolved to a campaign / owner). */
  hasToken: boolean;
  /** The campaign has a Calendly event type chosen. */
  hasEventType: boolean;
}): BookingToolPlan {
  if (input.hasToken && input.hasEventType) return "live";
  if (input.hasToken) return "disabled";
  return input.live ? "not_configured" : "mock";
}

/** What the agent hears when a LIVE call reaches a booking tool with no
 *  Calendly behind it. Spoken-friendly: the model reads these nearly verbatim. */
export const BOOKING_NOT_CONFIGURED_MESSAGE = {
  get_available_times:
    "Scheduling isn't set up for this campaign yet, so I can't offer times right now. Don't invent a time — offer to have the team follow up instead.",
  book_appointment:
    "Scheduling isn't set up for this campaign yet, so I can't book that right now. Don't say it's booked — tell them the team will follow up to set a time.",
} as const;
