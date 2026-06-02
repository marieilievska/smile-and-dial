/** Helpers for the campaigns table: format Postgres TIME values
 *  ("09:00:00") as friendly windows ("9am – 5pm") and decide whether
 *  the current local time is inside the window.
 *
 *  Pure functions — pass `now` from the caller for deterministic
 *  tests. */

export function formatCallingHours(
  startHHmm: string | null | undefined,
  endHHmm: string | null | undefined,
): string {
  const start = parseTime(startHHmm ?? "09:00");
  const end = parseTime(endHHmm ?? "17:00");
  if (!start || !end) return "—";
  return `${formatHour(start)} – ${formatHour(end)}`;
}

/** Minutes-since-midnight of `now` as read in a specific IANA timezone.
 *  Uses Intl so it's DST-correct (no manual offset math). */
function minutesOfDayInTz(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  let h = 0;
  let m = 0;
  for (const p of parts) {
    if (p.type === "hour") h = Number(p.value) % 24;
    else if (p.type === "minute") m = Number(p.value);
  }
  return h * 60 + m;
}

/** Whether the window [start, end) is currently open in `timeZone`. */
export function isInsideCallingHoursTz(
  startHHmm: string | null | undefined,
  endHHmm: string | null | undefined,
  timeZone: string,
  now: Date = new Date(),
): boolean {
  const start = parseTime(startHHmm ?? "09:00");
  const end = parseTime(endHHmm ?? "17:00");
  if (!start || !end) return true;
  const curMinutes = minutesOfDayInTz(now, timeZone);
  const startMin = start.h * 60 + start.m;
  const endMin = end.h * 60 + end.m;
  // Windows that don't cross midnight (the common case).
  if (startMin <= endMin) return curMinutes >= startMin && curMinutes < endMin;
  // Overnight windows (e.g. 22:00 → 06:00).
  return curMinutes >= startMin || curMinutes < endMin;
}

/**
 * Campaign-level "are we calling right now?" — true if the window is open for
 * AT LEAST ONE of the campaign's lead timezones. The dialer gates per lead in
 * each lead's own timezone, so "someone is callable now" is the honest
 * campaign-wide signal (a campaign spanning Central + Alaska is dialing as
 * long as either is inside hours). Falls back to America/New_York when the
 * campaign has no leads with a timezone yet — matching the SQL default.
 */
export function isCampaignInsideHours(
  startHHmm: string | null | undefined,
  endHHmm: string | null | undefined,
  timezones: string[],
  now: Date = new Date(),
): boolean {
  const zones = timezones.length > 0 ? timezones : ["America/New_York"];
  return zones.some((tz) =>
    isInsideCallingHoursTz(startHHmm, endHHmm, tz, now),
  );
}

/** Legacy single-zone check. Evaluated in America/New_York rather than the
 *  server clock (which is UTC on Vercel and made every evening read as
 *  "outside hours"). Prefer isCampaignInsideHours for campaign chips. */
export function isInsideCallingHours(
  startHHmm: string | null | undefined,
  endHHmm: string | null | undefined,
  now: Date = new Date(),
): boolean {
  return isInsideCallingHoursTz(startHHmm, endHHmm, "America/New_York", now);
}

function parseTime(s: string): { h: number; m: number } | null {
  const [hh, mm] = s.split(":");
  const h = Number(hh);
  const m = Number(mm);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return { h, m };
}

function formatHour({ h, m }: { h: number; m: number }): string {
  const ampm = h < 12 ? "am" : "pm";
  const h12 = ((h + 11) % 12) + 1;
  return m === 0
    ? `${h12}${ampm}`
    : `${h12}:${String(m).padStart(2, "0")}${ampm}`;
}
