// Eastern-time day helpers. The whole app reasons about "days" in US Eastern
// (America/New_York), so a call placed at 9pm ET still belongs to that ET day —
// not the next UTC day. Use these instead of UTC/server-local date math
// anywhere you bucket, filter, or display by calendar day.
//
// (The Reporting page's etDay() in lib/agent-analytics/stats.ts predates this
// module and does the same YYYY-MM-DD formatting; this module adds the UTC
// boundary + hour helpers the rest of the app needs.)

const TZ = "America/New_York";

/** The Eastern calendar date (YYYY-MM-DD) of an instant. */
export function etDayString(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(date);
}

/** Eastern UTC offset in hours for the given instant (e.g. -4 EDT, -5 EST). */
function etOffsetHours(date: Date): number {
  const name =
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      timeZoneName: "shortOffset",
    })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT-5";
  const m = /GMT([+-]\d{1,2})(?::?(\d{2}))?/.exec(name);
  if (!m) return -5;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  return h + (h < 0 ? -min : min) / 60;
}

/** UTC instant (ISO) of midnight Eastern on the given ET date (YYYY-MM-DD). */
export function etMidnightUtcIso(etDate: string): string {
  const [y, mo, d] = etDate.split("-").map(Number);
  // Sample the offset at ~noon that day to dodge the DST-transition hour.
  const offset = etOffsetHours(new Date(Date.UTC(y, mo - 1, d, 12, 0, 0)));
  return new Date(Date.UTC(y, mo - 1, d, -offset, 0, 0)).toISOString();
}

/** [startUtc, endUtc) — UTC instants bounding an ET calendar day. endUtc is
 *  exclusive (the start of the next ET day). */
export function etDayRangeUtc(etDate: string): {
  startUtc: string;
  endUtc: string;
} {
  const [y, mo, d] = etDate.split("-").map(Number);
  const nextEtDate = etDayString(
    new Date(Date.UTC(y, mo - 1, d + 1, 12, 0, 0)),
  );
  return {
    startUtc: etMidnightUtcIso(etDate),
    endUtc: etMidnightUtcIso(nextEtDate),
  };
}

/** Inclusive end-of-day ISO for an ET date (next ET midnight − 1ms) — for
 *  queries that compare with `.lte`. */
export function endOfEtDayUtcIso(etDate: string): string {
  return new Date(
    new Date(etDayRangeUtc(etDate).endUtc).getTime() - 1,
  ).toISOString();
}

/** UTC instant (ISO) of the start of *today* in Eastern. */
export function startOfTodayEtIso(now: Date = new Date()): string {
  return etMidnightUtcIso(etDayString(now));
}

/** Hour 0–23 of an instant in Eastern. */
export function etHour(date: Date = new Date()): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(date),
  );
}

/** N days before today's ET date, as YYYY-MM-DD (tz-neutral date math). */
export function etDateDaysAgo(n: number, now: Date = new Date()): string {
  const [y, mo, d] = etDayString(now).split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d - n)).toISOString().slice(0, 10);
}

/** Query bounds for a YYYY-MM-DD `from`/`to` pair typed into a date filter:
 *  `gte` = ET midnight of `from`, `lte` = last ms of the ET day `to`. Blank or
 *  malformed inputs are dropped. Without this, `.gte(col, "2026-09-03")` is
 *  read by Postgres as UTC midnight, 4–5 hours before the Eastern day. */
export function etDayFilterBounds(
  from: string | null | undefined,
  to: string | null | undefined,
): { gte?: string; lte?: string } {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const out: { gte?: string; lte?: string } = {};
  if (from && DATE_RE.test(from)) out.gte = etMidnightUtcIso(from);
  if (to && DATE_RE.test(to)) out.lte = endOfEtDayUtcIso(to);
  return out;
}

// ---------------------------------------------------------------------------
// DISPLAY. Every date/time the app SHOWS is rendered in Eastern, no matter
// where it renders (Vercel = UTC on the server) or where the viewer's device
// is set. The team works in Eastern; a callback that fires at 3pm Pacific is
// shown as 6pm here, on purpose. Prefer these over bare toLocale*String().
// ---------------------------------------------------------------------------

export const ET_TZ = TZ;

type DateInput = string | number | Date | null | undefined;

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** Format an instant in Eastern with any Intl options. Locale is pinned to
 *  en-US so server and client render the same string (no hydration drift). */
export function etFormat(
  value: DateInput,
  options: Intl.DateTimeFormatOptions,
  fallback = "",
): string {
  const d = toDate(value);
  if (!d) return fallback;
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone: TZ }).format(
    d,
  );
}

/** "Sep 2, 9:43 PM" (pass `withZone` for "Sep 2, 9:43 PM EDT"). */
export function etDateTime(
  value: DateInput,
  fallback = "—",
  withZone = false,
): string {
  return etFormat(
    value,
    withZone
      ? {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        }
      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
    fallback,
  );
}

/** "9/2/2026, 9:43:48 PM EDT" — the exact form, for hover tooltips. */
export function etDateTimeExact(value: DateInput, fallback = ""): string {
  return etFormat(
    value,
    {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    },
    fallback,
  );
}

/** "9:43 PM" (pass `withZone` for "9:43 PM EDT"). */
export function etTime(
  value: DateInput,
  fallback = "",
  withZone = false,
): string {
  return etFormat(
    value,
    withZone
      ? { hour: "numeric", minute: "2-digit", timeZoneName: "short" }
      : { hour: "numeric", minute: "2-digit" },
    fallback,
  );
}

/** "Sep 2" — or "Sep 2, 2025" when the year differs from `now`'s ET year. */
export function etDate(
  value: DateInput,
  fallback = "",
  now: Date = new Date(),
): string {
  const d = toDate(value);
  if (!d) return fallback;
  const sameYear = etDayString(d).slice(0, 4) === etDayString(now).slice(0, 4);
  return etFormat(
    d,
    sameYear
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
    fallback,
  );
}

/** "9/2/2026" */
export function etDateNumeric(value: DateInput, fallback = ""): string {
  return etFormat(
    value,
    { year: "numeric", month: "numeric", day: "numeric" },
    fallback,
  );
}

/** "Wed" */
export function etWeekdayShort(value: DateInput, fallback = ""): string {
  return etFormat(value, { weekday: "short" }, fallback);
}

/** Whole Eastern calendar days from `from` to `to` (positive = `to` is later). */
export function etDayDelta(from: Date, to: Date): number {
  const [fy, fm, fd] = etDayString(from).split("-").map(Number);
  const [ty, tm, td] = etDayString(to).split("-").map(Number);
  return Math.round(
    (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000,
  );
}

/** Humanize a PAST timestamp the way the tables do: "just now" / "12m ago" /
 *  "3h ago" (same ET day) / "Yesterday" / "Tue" (<7 days) / "May 12" / "May 12,
 *  2024". Day buckets are Eastern calendar days. Pure — pass `now` for tests. */
export function etPastLabel(value: DateInput, now: Date = new Date()): string {
  const d = toDate(value);
  if (!d) return "—";
  const deltaMs = now.getTime() - d.getTime();
  if (deltaMs < 0) return etDateNumeric(d);
  const min = Math.floor(deltaMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const dayDelta = etDayDelta(d, now);
  if (dayDelta === 0) return `${Math.floor(min / 60)}h ago`;
  if (dayDelta === 1) return "Yesterday";
  if (dayDelta < 7) return etWeekdayShort(d);
  return etDate(d, "", now);
}

/** "Sep 1 – Sep 27" for a YYYY-MM-DD range label (calendar dates, no zone). */
export function dateRangeLabel(from: string, to: string): string {
  const f = new Date(`${from}T12:00:00Z`);
  const t = new Date(`${to}T12:00:00Z`);
  if (!Number.isFinite(f.getTime()) || !Number.isFinite(t.getTime())) {
    return `${from} → ${to}`;
  }
  const opts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  };
  const fmt = (d: Date) => new Intl.DateTimeFormat("en-US", opts).format(d);
  return from === to ? fmt(f) : `${fmt(f)} – ${fmt(t)}`;
}

/** "May 12" for a YYYY-MM-DD calendar date (no zone shift: the string IS the
 *  day, so it is formatted as UTC-midnight in UTC). Pass `withYear` for
 *  "May 12, 2024". */
export function ymdLabel(ymd: string, withYear = false): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  if (!Number.isFinite(d.getTime())) return ymd;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(d);
}

/** Eastern wall-clock "YYYY-MM-DDTHH:mm" of an instant, for prefilling a
 *  `datetime-local` input. Pair with etWallClockToIso when reading it back. */
export function etWallClock(value: DateInput): string {
  const d = toDate(value);
  if (!d) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}

/** Read a `datetime-local` value ("YYYY-MM-DDTHH:mm") as an EASTERN
 *  wall-clock time and return the UTC ISO instant. Every operator types
 *  times in ET, whatever zone their laptop is set to. Null when unparseable.
 *  DST-correct via the Intl offset-correction trick. */
export function etWallClockToIso(wall: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wall ?? "");
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const rb = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(guess));
  const n = (t: string) => Number(rb.find((p) => p.type === t)?.value);
  const read = Date.UTC(
    n("year"),
    n("month") - 1,
    n("day"),
    n("hour"),
    n("minute"),
    0,
  );
  return new Date(guess - (read - guess)).toISOString();
}
