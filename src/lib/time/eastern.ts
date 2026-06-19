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
