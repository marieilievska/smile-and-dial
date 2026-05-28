/** Humanize the Started column on the per-call costs table. Matches
 *  the DNC and Today page treatments — recent rows read as "12m ago"
 *  / "3h ago" / "Yesterday", older ones as concrete dates.
 *
 *  Pure function — pass `now` to keep render deterministic in tests. */
export function formatStartedAt(iso: string, now: Date = new Date()): string {
  const started = new Date(iso);
  const deltaMs = now.getTime() - started.getTime();
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    return started.toLocaleString();
  }
  const min = Math.floor(deltaMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);
  const startCall = new Date(started);
  startCall.setHours(0, 0, 0, 0);
  const dayDelta = Math.round(
    (startToday.getTime() - startCall.getTime()) / 86_400_000,
  );
  if (dayDelta === 0) {
    const h = Math.floor(min / 60);
    return `${h}h ago`;
  }
  if (dayDelta === 1) return "Yesterday";
  if (dayDelta < 7) {
    return started.toLocaleDateString(undefined, { weekday: "short" });
  }
  if (started.getFullYear() === now.getFullYear()) {
    return started.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }
  return started.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** "May 1 – May 27" humanization for the page header. Same helper as
 *  the analytics page. */
export function fmtRangeLabel(from: string, to: string): string {
  try {
    const f = new Date(`${from}T00:00:00Z`);
    const t = new Date(`${to}T00:00:00Z`);
    const fmt: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
    if (from === to) return f.toLocaleDateString(undefined, fmt);
    return `${f.toLocaleDateString(undefined, fmt)} – ${t.toLocaleDateString(undefined, fmt)}`;
  } catch {
    return `${from} → ${to}`;
  }
}
