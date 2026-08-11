/**
 * True when `bookings` already contains a scheduled booking at the same instant
 * as `whenIso`. Compares as time INSTANTS, not raw strings, so a DB timestamptz
 * ("2026-08-13T17:00:00+00:00") matches a `Date.toISOString()` value
 * ("2026-08-13T17:00:00.000Z") for the same moment. Pure.
 *
 * Used by book_appointment to skip creating a second Calendly invitee when the
 * lead is already registered for this event at this slot — the fix for the
 * double-booking that appeared once the cancel-based de-dup was removed (which
 * had to go because cancelling a shared webinar session drops every registrant).
 */
export function hasBookingAtSlot(
  bookings: { scheduled_at: string | null }[],
  whenIso: string,
): boolean {
  const target = new Date(whenIso).getTime();
  if (Number.isNaN(target)) return false;
  return bookings.some((b) => {
    if (!b.scheduled_at) return false;
    const t = new Date(b.scheduled_at).getTime();
    return !Number.isNaN(t) && t === target;
  });
}
