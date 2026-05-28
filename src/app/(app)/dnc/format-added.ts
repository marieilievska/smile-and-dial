/** Humanize the `added_at` timestamp for the DNC table. Reads cleaner
 *  than a raw `M/D/YYYY` for recent rows, while keeping a concrete date
 *  for older ones so the eye doesn't have to guess.
 *
 *  Outputs:
 *   - <1m: "just now"
 *   - <60m: "12m ago"
 *   - same day: "3h ago"
 *   - 1d ago: "Yesterday"
 *   - 2-6d ago: "Tue"
 *   - this year: "May 12"
 *   - older:    "May 12, 2024"
 *
 *  Pure function — pass `now` to keep render deterministic in tests. */
export function formatAddedAt(
  addedAtIso: string,
  now: Date = new Date(),
): string {
  const added = new Date(addedAtIso);
  const deltaMs = now.getTime() - added.getTime();
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    return added.toLocaleDateString();
  }
  const min = Math.floor(deltaMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);
  const startAdded = new Date(added);
  startAdded.setHours(0, 0, 0, 0);
  const dayDelta = Math.round(
    (startToday.getTime() - startAdded.getTime()) / 86_400_000,
  );
  if (dayDelta === 0) {
    const h = Math.floor(min / 60);
    return `${h}h ago`;
  }
  if (dayDelta === 1) return "Yesterday";
  if (dayDelta < 7) {
    return added.toLocaleDateString(undefined, { weekday: "short" });
  }
  if (added.getFullYear() === now.getFullYear()) {
    return added.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }
  return added.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
