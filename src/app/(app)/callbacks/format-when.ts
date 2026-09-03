import { ET_TZ, etDayDelta } from "@/lib/time/eastern";

/** Format a scheduled-at timestamp as a human-readable relative
 *  time, plus indicate whether the callback is overdue or urgent
 *  (due within the next hour).
 *
 *  Outputs:
 *   - Overdue:  "Overdue 1h 20m"  → urgency: "overdue"
 *   - Urgent:   "In 12m"          → urgency: "urgent"  (≤ 1h away)
 *   - Soon:     "In 2h 15m"       → urgency: "normal"
 *   - Tomorrow: "Tomorrow at 10:00 AM"
 *   - This week: "Wed at 3:00 PM"
 *   - Later:    "5/30 at 9:00 AM"
 *
 *  Pure function, no Date.now() side effects beyond the call site —
 *  the page passes in `now` so the same render is deterministic
 *  for tests. */
export type ScheduledUrgency = "overdue" | "urgent" | "normal";

export function formatScheduledWhen(
  scheduledAtIso: string,
  now: Date = new Date(),
  /** A resolved callback (completed/cancelled/missed) is never "overdue" — its
   *  scheduled time is just history, so show the absolute date/time, no urgency. */
  resolved = false,
): { primary: string; urgency: ScheduledUrgency } {
  const scheduled = new Date(scheduledAtIso);
  if (resolved) {
    return { primary: formatAbsolute(scheduled), urgency: "normal" };
  }
  const deltaMs = scheduled.getTime() - now.getTime();
  const absMin = Math.floor(Math.abs(deltaMs) / 60_000);

  // Overdue (in the past)
  if (deltaMs < 0) {
    return {
      primary: `Overdue ${humanizeMinutes(absMin)}`,
      urgency: "overdue",
    };
  }

  // Calendar-day delta in Eastern days (the app-wide convention) — never the
  // server's UTC clock, which called a 9pm ET callback "tomorrow".
  const dayDelta = etDayDelta(now, scheduled);

  if (dayDelta === 0) {
    // Today — show relative "In Xh Ym"
    return {
      primary: `In ${humanizeMinutes(absMin)}`,
      urgency: absMin <= 60 ? "urgent" : "normal",
    };
  }

  if (dayDelta === 1) {
    return {
      primary: `Tomorrow at ${formatTime(scheduled)}`,
      urgency: "normal",
    };
  }

  if (dayDelta > 1 && dayDelta <= 6) {
    // Within the next week → "Wed at 3:00 PM"
    const weekday = scheduled.toLocaleDateString("en-US", {
      weekday: "short",
      timeZone: ET_TZ,
    });
    return {
      primary: `${weekday} at ${formatTime(scheduled)}`,
      urgency: "normal",
    };
  }

  // Further out → "5/30 at 9:00 AM"
  const date = scheduled.toLocaleDateString("en-US", {
    month: "numeric",
    day: "numeric",
    timeZone: ET_TZ,
  });
  return {
    primary: `${date} at ${formatTime(scheduled)}`,
    urgency: "normal",
  };
}

/** Absolute "M/D at h:mm AM TZ" — used for resolved callbacks (no relative
 *  "overdue"/"in Xh" framing). */
function formatAbsolute(d: Date): string {
  const date = d.toLocaleDateString("en-US", {
    month: "numeric",
    day: "numeric",
    timeZone: ET_TZ,
  });
  return `${date} at ${formatTime(d)}`;
}

function humanizeMinutes(min: number): string {
  if (min < 1) return "<1m";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Clock time PLUS the Eastern abbreviation — "3:00 PM EDT". A callback fires
 *  in the LEAD's local time but the team reads it in Eastern (a 3pm Pacific
 *  callback shows as 6:00 PM EDT), so the label makes that explicit. */
function formatTime(d: Date): string {
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: ET_TZ,
    timeZoneName: "short",
  });
}
