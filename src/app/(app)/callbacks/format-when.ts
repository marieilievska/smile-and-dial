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
): { primary: string; urgency: ScheduledUrgency } {
  const scheduled = new Date(scheduledAtIso);
  const deltaMs = scheduled.getTime() - now.getTime();
  const absMin = Math.floor(Math.abs(deltaMs) / 60_000);

  // Overdue (in the past)
  if (deltaMs < 0) {
    return {
      primary: `Overdue ${humanizeMinutes(absMin)}`,
      urgency: "overdue",
    };
  }

  // Same calendar day?
  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);
  const startScheduledDay = new Date(scheduled);
  startScheduledDay.setHours(0, 0, 0, 0);
  const dayDelta = Math.round(
    (startScheduledDay.getTime() - startToday.getTime()) / 86_400_000,
  );

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
    const weekday = scheduled.toLocaleDateString(undefined, {
      weekday: "short",
    });
    return {
      primary: `${weekday} at ${formatTime(scheduled)}`,
      urgency: "normal",
    };
  }

  // Further out → "5/30 at 9:00 AM"
  const m = scheduled.getMonth() + 1;
  const d = scheduled.getDate();
  return {
    primary: `${m}/${d} at ${formatTime(scheduled)}`,
    urgency: "normal",
  };
}

function humanizeMinutes(min: number): string {
  if (min < 1) return "<1m";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
