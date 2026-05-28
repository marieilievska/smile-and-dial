/** Humanize a system_event `created_at` for the table. Recent events
 *  read better as relative ("2m ago") so an admin investigating a
 *  fresh incident doesn't have to subtract minutes in their head.
 *
 *  Pure function — pass `now` to keep render deterministic in tests. */
export function formatEventWhen(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const deltaMs = now.getTime() - at.getTime();
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    return at.toLocaleString();
  }
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);
  const startEvent = new Date(at);
  startEvent.setHours(0, 0, 0, 0);
  const dayDelta = Math.round(
    (startToday.getTime() - startEvent.getTime()) / 86_400_000,
  );
  if (dayDelta === 0) {
    const h = Math.floor(min / 60);
    return `${h}h ago`;
  }
  if (dayDelta === 1) return "Yesterday";
  if (dayDelta < 7) {
    return at.toLocaleDateString(undefined, { weekday: "short" });
  }
  if (at.getFullYear() === now.getFullYear()) {
    return at.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }
  return at.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
