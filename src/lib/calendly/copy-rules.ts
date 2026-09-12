/**
 * How much we trust our copy of Calendly's open times, and which of them are
 * worth offering. Pure (no server-only, no network, no clock of its own) so
 * every threshold is unit-tested rather than reasoned about.
 *
 * Why a copy at all: asking Calendly during the call costs 1.0-1.4 s of
 * silence (measured 2026-09-11), and five of the six people who reached that
 * step on 2026-09-10 without booking hung up inside it. The dialer refreshes
 * the copy while it is placing calls, so a live call normally reads one under a
 * minute old; these rules decide what to do when it isn't.
 */

/** Serve the copy without a second thought. */
export const COPY_FRESH_MS = 2 * 60_000;
/** Serve the copy, then refresh it in the background for the next caller. */
export const COPY_USABLE_MS = 10 * 60_000;
/** Only good enough when Calendly itself won't answer: better than telling a
 *  willing lead there is nothing open. */
export const COPY_FALLBACK_MS = 60 * 60_000;
/** The dialer tops the copy up when it is older than this. */
export const WARM_AFTER_MS = 60_000;
/** Never offer a session starting sooner than this. It MIRRORS the Calendly
 *  event's minimum scheduling notice — 30 minutes on the daily webinar, set in
 *  Calendly (Marija, 2026-09-12) — which Calendly's API does not expose, so it
 *  cannot be read. A live read already respects the notice at the moment it is
 *  made; this keeps an OLDER copy honest as the clock moves (a copy read at 1:21
 *  still holds the 2 PM session, which Calendly refuses from 1:30). If the notice
 *  is changed in Calendly, change this with it. */
export const SLOT_MIN_LEAD_MS = 30 * 60_000;
/** Stop waiting on Calendly's availability endpoint. The tool has 20 s before
 *  ElevenLabs abandons it, but the caller is listening to silence the whole
 *  time, and a copy up to an hour old beats four more seconds of nothing. */
export const AVAILABILITY_TIMEOUT_MS = 4_000;

export type CopyFreshness = "fresh" | "usable" | "fallback_only" | "expired";

function ageMs(
  fetchedAt: string | null | undefined,
  nowMs: number,
): number | null {
  if (!fetchedAt) return null;
  const at = Date.parse(fetchedAt);
  if (Number.isNaN(at)) return null;
  // A copy stamped in the future (clock skew between us and Postgres) is as
  // fresh as it gets, never "expired".
  return Math.max(0, nowMs - at);
}

export function copyFreshness(
  fetchedAt: string | null | undefined,
  nowMs: number,
): CopyFreshness {
  const age = ageMs(fetchedAt, nowMs);
  if (age === null) return "expired";
  if (age <= COPY_FRESH_MS) return "fresh";
  if (age <= COPY_USABLE_MS) return "usable";
  if (age <= COPY_FALLBACK_MS) return "fallback_only";
  return "expired";
}

/** Whole seconds since the copy was read, for the audit row. */
export function copyAgeSeconds(
  fetchedAt: string | null | undefined,
  nowMs: number,
): number | null {
  const age = ageMs(fetchedAt, nowMs);
  return age === null ? null : Math.round(age / 1000);
}

/** The stored copy, defensively: a jsonb column can hold anything. */
export function parseSlotList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v)),
  );
}

/** The slots worth offering right now, soonest first. */
export function offerableSlots(
  slots: readonly string[],
  nowMs: number,
): string[] {
  return slots
    .filter((s) => Date.parse(s) > nowMs + SLOT_MIN_LEAD_MS)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
}

/** The session a fixed-time (webinar) booking should take from the copy: the
 *  first offerable slot, but ONLY from a copy fresh or usable enough to book
 *  from (at most COPY_USABLE_MS old). Anything older returns null so the caller
 *  does a live scan instead — that path books immediately, with no list to fall
 *  back on if Calendly rejects a stale slot. */
export function soonestFromCopy(
  slots: unknown,
  fetchedAt: string | null | undefined,
  nowMs: number,
): string | null {
  const freshness = copyFreshness(fetchedAt, nowMs);
  if (freshness !== "fresh" && freshness !== "usable") return null;
  return offerableSlots(parseSlotList(slots), nowMs)[0] ?? null;
}

/** Should the dialer refresh this event's copy on this tick? */
export function needsWarm(
  fetchedAt: string | null | undefined,
  nowMs: number,
): boolean {
  const age = ageMs(fetchedAt, nowMs);
  return age === null || age > WARM_AFTER_MS;
}
