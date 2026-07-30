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
