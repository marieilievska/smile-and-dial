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
  /** The LEAD's timezone, so "Tomorrow at 10:00 AM" and the clock time read in
   *  the lead's local time — not the server's (UTC on Vercel), which rendered a
   *  2:40pm-local callback as "7:40". Falls back to the runtime default tz. */
  timeZone?: string,
  /** A resolved callback (completed/cancelled/missed) is never "overdue" — its
   *  scheduled time is just history, so show the absolute date/time, no urgency. */
  resolved = false,
): { primary: string; urgency: ScheduledUrgency } {
  const scheduled = new Date(scheduledAtIso);
  if (resolved) {
    return { primary: formatAbsolute(scheduled, timeZone), urgency: "normal" };
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

  // Calendar-day delta as seen in the lead's timezone (not server-local).
  const dayDelta = tzDayDelta(now, scheduled, timeZone);

  if (dayDelta === 0) {
    // Today — show relative "In Xh Ym"
    return {
      primary: `In ${humanizeMinutes(absMin)}`,
      urgency: absMin <= 60 ? "urgent" : "normal",
    };
  }

  if (dayDelta === 1) {
    return {
      primary: `Tomorrow at ${formatTime(scheduled, timeZone)}`,
      urgency: "normal",
    };
  }

  if (dayDelta > 1 && dayDelta <= 6) {
    // Within the next week → "Wed at 3:00 PM"
    const weekday = scheduled.toLocaleDateString(undefined, {
      weekday: "short",
      timeZone,
    });
    return {
      primary: `${weekday} at ${formatTime(scheduled, timeZone)}`,
      urgency: "normal",
    };
  }

  // Further out → "5/30 at 9:00 AM"
  const date = scheduled.toLocaleDateString(undefined, {
    month: "numeric",
    day: "numeric",
    timeZone,
  });
  return {
    primary: `${date} at ${formatTime(scheduled, timeZone)}`,
    urgency: "normal",
  };
}

/** Whole-day difference between two instants as seen in `timeZone`, so a late-
 *  evening callback isn't called "tomorrow" just because it's past UTC
 *  midnight. */
function tzDayDelta(now: Date, scheduled: Date, timeZone?: string): number {
  const ymd = (d: Date) => d.toLocaleDateString("en-CA", { timeZone });
  const a = new Date(`${ymd(now)}T00:00:00Z`).getTime();
  const b = new Date(`${ymd(scheduled)}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** Absolute "M/D at h:mm AM TZ" — used for resolved callbacks (no relative
 *  "overdue"/"in Xh" framing). */
function formatAbsolute(d: Date, timeZone?: string): string {
  const date = d.toLocaleDateString(undefined, {
    month: "numeric",
    day: "numeric",
    timeZone,
  });
  return `${date} at ${formatTime(d, timeZone)}`;
}

function humanizeMinutes(min: number): string {
  if (min < 1) return "<1m";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Clock time PLUS a short timezone abbreviation — "3:00 PM EDT". A callback
 *  fires in the LEAD's local time, so labeling the zone makes "whose 3 PM"
 *  unambiguous to the operator. When no lead timezone is known we fall back to
 *  the viewer's runtime zone (timeZone left undefined) and still label it, so
 *  the time is never bare. The `timeZoneName: "short"` part yields the
 *  abbreviation (EDT/CST/…); Intl appends it after the time. */
function formatTime(d: Date, timeZone?: string): string {
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  });
}
