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

/**
 * Parse an agent-supplied callback datetime as the LEAD's local wall-clock
 * time, IGNORING any UTC offset the model attached.
 *
 * Why: the model writes the clock time the person actually said ("tomorrow
 * morning" -> 10:00) but stamps it with an Eastern offset (-04:00) for every
 * lead, Hawaii included — so "10:00-04:00" for a Honolulu spa came out as
 * 4 AM their time. The wall clock is the trustworthy part; the offset is
 * not. Reading "YYYY-MM-DDTHH:mm" in the lead's zone makes 10:00 mean 10:00
 * where they are. Falls back to the plain parser for non-ISO input.
 */
export function parseLeadLocalDatetime(
  raw: string | null | undefined,
  timeZone: string | null | undefined,
): Date | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return parseZonedDatetime(s, timeZone);
  return parseZonedDatetime(m[0], timeZone);
}

/**
 * Roll an absolute instant forward off the weekend, PRESERVING its local
 * wall-clock time in `timeZone`. A Saturday → the same time Monday (+2 days), a
 * Sunday → the same time Monday (+1). Weekdays return unchanged.
 *
 * Unlike `localHourDaysAheadIso` (which normalizes to a fixed hour), this keeps
 * the original time-of-day — used for callback retries, where the lead agreed to
 * a specific time and we only want to skip the non-calling weekend days. Without
 * it, a Friday callback's "next day, same time" retry landed on Saturday, where
 * the weekday-only calling-hours gate blocked it and it sat overdue.
 *
 * DST-correct via the same Intl offset-correction trick the helpers above use.
 */
export function rollIsoOffWeekend(
  instant: Date,
  timeZone: string | null | undefined,
): string {
  const tz = timeZone || "America/New_York";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const num = (t: string) => Number(parts.find((x) => x.type === t)?.value);
  const y = num("year");
  const mo = num("month");
  const h = num("hour") % 24;
  const mi = num("minute");
  // Weekday of the local calendar date (getUTCDay on a midnight-UTC date built
  // from the local Y/M/D gives that date's weekday regardless of tz).
  let day = num("day");
  const dow = new Date(Date.UTC(y, mo - 1, day)).getUTCDay();
  if (dow === 6)
    day += 2; // Saturday → Monday
  else if (dow === 0) day += 1; // Sunday → Monday
  // Rebuild the instant at the (possibly rolled) local wall-clock time.
  const wallGuess = Date.UTC(y, mo - 1, day, h, mi, 0);
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

/**
 * Guard against same-day re-dials from NON-appointment dispositions. A real
 * `callback` outcome (an agreed appointment) is honored as-is, but a "call back"
 * the agent booked off a gatekeeper / brush-off should never re-dial the same
 * number the SAME day. If `iso` falls today in the lead's tz (or earlier),
 * return the NEXT calling day's standard morning slot (weekend-rolled); a
 * genuinely future day is kept (just guaranteed to be a weekday).
 */
export function deferSameDayCallbackIso(
  iso: string,
  timeZone: string | null | undefined,
): string {
  const tz = timeZone || "America/New_York";
  const ymd = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d); // YYYY-MM-DD — lexicographic compare == chronological
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return iso;
  if (ymd(target) > ymd(new Date())) {
    // Already a future local day — keep the agreed day, just ensure a weekday.
    return rollIsoOffWeekend(target, tz);
  }
  // Today (or earlier): bump to the next calling day's morning slot.
  return localHourDaysAheadIso(tz, 1, 10);
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

/** The smallest gap we will ever leave between "now" and a callback we are
 *  writing. A callback is dialed at dial_priority 0 and bypasses the throughput
 *  caps, so one written in the past is redeemed on the very next tick — which
 *  is how a Halifax lead was called at 08:36, 08:38 and 08:40 and asked to be
 *  removed ("It has not been 20 minutes. You just called me three times in a
 *  row."). Five minutes is long enough that the next tick can't re-dial the
 *  number we just hung up on, and short enough to honour a genuine
 *  "call me right back". */
export const CALLBACK_FLOOR_MS = 5 * 60 * 1000;

/** system_events kind written when the floor above actually bit — i.e. we
 *  stopped a callback from being stored at a time that had already passed.
 *  Shared so the writer and the Activity feed's label can't drift apart. */
export const CALLBACK_PAST_TIME_CLAMPED = "callback_past_time_clamped";

/** The instant a datetime string names IF its own trailing offset is taken at
 *  face value. Null when the string carries no offset (there is nothing to
 *  trust) or can't be parsed. */
function parseStampedInstant(raw: string | null | undefined): Date | null {
  const s = (raw ?? "").trim();
  if (!/([Zz]|[+-]\d{2}:?\d{2})$/.test(s)) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Resolve an agent-supplied callback datetime, preferring the lead's wall clock
 * but falling back to the offset the model stamped when the wall-clock reading
 * would land in the past.
 *
 * `parseLeadLocalDatetime` throws the model's offset away on purpose, because
 * the model writes the clock time the person actually said and stamps Eastern
 * on every lead — "10:00-04:00" for a Honolulu spa means 10:00 HST, and
 * honouring the offset booked it at 4 AM. That is right for a NAMED time.
 *
 * It is wrong for a RELATIVE one. ElevenLabs does not interpolate dynamic
 * variables into data-collection field descriptions (the analysis result comes
 * back with the literal `{{current_time}}` still in its json_schema), so the
 * post-call extractor never learns the lead's local clock and counts "in 20
 * minutes" from ElevenLabs' own `system__timezone`, America/New_York. For an
 * Atlantic lead it then wrote `2026-09-11T08:52:00-04:00` — the correct instant
 * (12:52Z, 19 minutes out) in the wrong zone's wall clock — and re-reading
 * "08:52" as Halifax moved it an hour earlier, to 40 minutes before the call it
 * came from had even ended.
 *
 * The two cases can't be told apart from the string. They can be told apart by
 * result: the extractor is never trying to book the past, so when the
 * lead-local reading is already behind us and the stamped offset is still
 * ahead, the stamped offset is the reading that was meant. When both are behind
 * us there is nothing to recover and the lead-local reading is returned for the
 * caller to clamp or reject.
 */
export function resolveCallbackDatetime(
  raw: string | null | undefined,
  timeZone: string | null | undefined,
  now: Date = new Date(),
): Date | null {
  const local = parseLeadLocalDatetime(raw, timeZone);
  if (!local) return null;
  if (local.getTime() > now.getTime()) return local;
  const stamped = parseStampedInstant(raw);
  if (stamped && stamped.getTime() > now.getTime()) return stamped;
  return local;
}

/** Push a callback time forward to `now + CALLBACK_FLOOR_MS` if it is sooner
 *  than that. Clamping rather than rejecting is deliberate on the paths that
 *  run after the call has ended: there is no one left to re-ask, and dropping
 *  the row entirely would lose a lead who explicitly asked to be called back. */
export function clampCallbackToFloor(when: Date, now: Date = new Date()): Date {
  const floor = now.getTime() + CALLBACK_FLOOR_MS;
  return when.getTime() >= floor ? when : new Date(floor);
}

/** The longest delay we accept as a RELATIVE callback. Past this the request
 *  was a named time ("tomorrow", "Monday morning"), and a named time belongs in
 *  callback_datetime — where reading the clock in the lead's own zone is the
 *  correct thing to do. Anything longer therefore falls back to that path
 *  rather than being honoured as a raw offset from the end of the call. Eight
 *  hours comfortably covers every same-session "call me back shortly". */
export const MAX_CALLBACK_RELATIVE_MINUTES = 8 * 60;

/**
 * Read the agent's "call me back in N minutes" answer.
 *
 * This is the escape hatch from a frame mismatch that cannot be resolved any
 * other way. The model expresses a callback as a wall clock, and for a RELATIVE
 * request it writes that clock in ElevenLabs' own zone (America/New_York) no
 * matter where the lead is — so "in an hour" for a Los Angeles lead came back
 * as `13:47-04:00`: the right instant, the wrong zone's clock. Re-reading
 * "13:47" in Los Angeles then books it three hours late. The two readings are
 * both valid-looking and both in the future, so nothing downstream can pick
 * between them (see resolveCallbackDatetime, which can only rescue the reading
 * that lands in the PAST).
 *
 * A count of minutes has no zone and no clock in it, so there is nothing to
 * misread. Accepts a number or a numeric string (ElevenLabs sends tool
 * arguments as strings), and returns null for anything that isn't a sane,
 * positive, near-term delay — the caller then falls back to the datetime.
 */
export function parseRelativeCallbackMinutes(raw: unknown): number | null {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(n)) return null;
  const minutes = Math.round(n);
  if (minutes <= 0 || minutes > MAX_CALLBACK_RELATIVE_MINUTES) return null;
  return minutes;
}

/** The instant `minutes` after `from`. Null when the minute count isn't a sane
 *  relative delay, which is the caller's signal to use the datetime instead. */
export function relativeCallbackInstant(
  raw: unknown,
  from: Date = new Date(),
): Date | null {
  const minutes = parseRelativeCallbackMinutes(raw);
  if (minutes === null || Number.isNaN(from.getTime())) return null;
  return new Date(from.getTime() + minutes * 60_000);
}
