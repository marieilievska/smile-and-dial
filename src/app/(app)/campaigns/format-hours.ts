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

/** Whether `now`'s local hour:minute falls inside [start, end). */
export function isInsideCallingHours(
  startHHmm: string | null | undefined,
  endHHmm: string | null | undefined,
  now: Date = new Date(),
): boolean {
  const start = parseTime(startHHmm ?? "09:00");
  const end = parseTime(endHHmm ?? "17:00");
  if (!start || !end) return true;
  const curMinutes = now.getHours() * 60 + now.getMinutes();
  const startMin = start.h * 60 + start.m;
  const endMin = end.h * 60 + end.m;
  // Windows that don't cross midnight (the common case).
  if (startMin <= endMin) return curMinutes >= startMin && curMinutes < endMin;
  // Overnight windows (e.g. 22:00 → 06:00).
  return curMinutes >= startMin || curMinutes < endMin;
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
