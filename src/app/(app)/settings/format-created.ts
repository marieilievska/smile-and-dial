/** Humanize a `created_at` (or any past) timestamp for the settings
 *  tables. Same shape as DNC `formatAddedAt` — recent rows read as
 *  relative ("3h ago"), older ones get a concrete date. Pure function —
 *  pass `now` to keep the render deterministic.
 *
 *  Centralised here so every settings page uses the same convention. */
export function formatCreatedAt(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const deltaMs = now.getTime() - at.getTime();
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    return at.toLocaleDateString();
  }
  const min = Math.floor(deltaMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);
  const startAt = new Date(at);
  startAt.setHours(0, 0, 0, 0);
  const dayDelta = Math.round(
    (startToday.getTime() - startAt.getTime()) / 86_400_000,
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
