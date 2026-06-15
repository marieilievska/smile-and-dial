import "server-only";

/**
 * UTC ISO for "`daysAhead` days from today at `hour`:00 in `timeZone`",
 * rolled forward off the weekend so it always lands on a calling day (Mon–Fri).
 *
 * Used to schedule the next retry at the START of the lead's calling day
 * (9am local by default) instead of copying the odd clock time of the call
 * that triggered the retry — which produced confusing "20 hours ago" style
 * Next-call timestamps. Specific callbacks the lead asked for keep their exact
 * time; only the generic retry cadence is normalized to this.
 *
 * Calling DAYS: the business calls Monday–Friday only. A computed Saturday rolls
 * to Monday (+2), a Sunday rolls to Monday (+1). Without this, retries and
 * "call back later" (+1 day) landed on weekends, where they sat undialed and
 * went stale in the past. The dialer's calling-hours gate also excludes
 * weekends (defense in depth), so a weekend date could never actually dial.
 *
 * DST-correct via the standard Intl offset-correction trick: interpret the
 * desired wall-clock instant as if it were UTC, read it back in the target
 * zone to discover that zone's offset there, then subtract the offset.
 */
/**
 * Parse an agent-supplied callback datetime into an absolute instant.
 *
 * If `raw` already carries a timezone — a trailing `Z` or a `±HH:MM` offset —
 * trust it. If the offset is MISSING (the LLM produced an otherwise-valid ISO
 * string but dropped the zone), interpret the wall-clock time in the LEAD's
 * timezone instead of letting `new Date()` silently assume UTC. Without this, a
 * "3pm" callback for an Atlantic lead returned as "2026-06-16T15:00:00" would be
 * stored as 15:00 UTC — i.e. noon Atlantic, three hours early. Returns null when
 * the value can't be parsed at all.
 *
 * DST-correct via the same Intl offset trick used by localHourDaysAheadIso.
 */
export function parseZonedDatetime(
  raw: string | null | undefined,
  timeZone: string | null | undefined,
): Date | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const hasOffset = /([Zz]|[+-]\d{2}:?\d{2})$/.test(s);
  if (hasOffset) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const tz = timeZone || "America/New_York";
  const wallGuess = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? 0),
  );
  const rbParts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(wallGuess));
  const rb = (t: string) => Number(rbParts.find((x) => x.type === t)?.value);
  const readMs = Date.UTC(
    rb("year"),
    rb("month") - 1,
    rb("day"),
    rb("hour") % 24,
    rb("minute"),
    rb("second"),
  );
  const offset = readMs - wallGuess;
  return new Date(wallGuess - offset);
}

export function localHourDaysAheadIso(
  timeZone: string | null | undefined,
  daysAhead: number,
  hour = 9,
): string {
  const tz = timeZone || "America/New_York";
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const num = (t: string) => Number(parts.find((x) => x.type === t)?.value);
  // Target calendar date, then rolled off the weekend. getUTCDay() on a
  // midnight-UTC Date built from the Y/M/D gives that date's weekday
  // (0 = Sunday … 6 = Saturday) regardless of the lead's timezone.
  let day = num("day") + daysAhead;
  const dow = new Date(
    Date.UTC(num("year"), num("month") - 1, day),
  ).getUTCDay();
  if (dow === 6)
    day += 2; // Saturday → Monday
  else if (dow === 0) day += 1; // Sunday → Monday
  const wallGuess = Date.UTC(num("year"), num("month") - 1, day, hour, 0, 0);
  const rbParts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(wallGuess));
  const rb = (t: string) => Number(rbParts.find((x) => x.type === t)?.value);
  const readMs = Date.UTC(
    rb("year"),
    rb("month") - 1,
    rb("day"),
    rb("hour") % 24,
    rb("minute"),
    0,
  );
  const offset = readMs - wallGuess;
  return new Date(wallGuess - offset).toISOString();
}
