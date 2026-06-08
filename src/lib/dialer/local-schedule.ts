import "server-only";

/**
 * UTC ISO for "`daysAhead` days from today at `hour`:00 in `timeZone`".
 *
 * Used to schedule the next retry at the START of the lead's calling day
 * (9am local by default) instead of copying the odd clock time of the call
 * that triggered the retry — which produced confusing "20 hours ago" style
 * Next-call timestamps. Specific callbacks the lead asked for keep their exact
 * time; only the generic retry cadence is normalized to this.
 *
 * DST-correct via the standard Intl offset-correction trick: interpret the
 * desired wall-clock instant as if it were UTC, read it back in the target
 * zone to discover that zone's offset there, then subtract the offset.
 */
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
  const wallGuess = Date.UTC(
    num("year"),
    num("month") - 1,
    num("day") + daysAhead,
    hour,
    0,
    0,
  );
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
