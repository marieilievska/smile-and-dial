/** Format a past timestamp as a human-readable "ago" string for the
 *  goals pipeline. Mirrors src/app/(app)/callbacks/format-when.ts but
 *  only handles the past direction.
 *
 *  Outputs:
 *   - "Just now"            <60s
 *   - "5m ago"              <60min
 *   - "3h ago"              <24h
 *   - "Yesterday"           1 day
 *   - "3d ago"              <7 days
 *   - "2w ago"              <30 days
 *   - "Mar 12"              older (with year omitted if current year)
 *
 *  Returns `null` when the timestamp is missing or unparseable so the
 *  caller can render a "—" placeholder.
 *
 *  Pure function — pass `now` in for deterministic tests. */
export function formatSince(
  iso: string | null,
  now: Date = new Date(),
): { label: string; stale: boolean } | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  const deltaMs = now.getTime() - ms;
  if (deltaMs < 0) return null;

  const sec = Math.floor(deltaMs / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  // "Stale" once the lead has been sitting in the pipeline for > 14
  // days without progress — surfaces in the UI as a coral attention
  // pill.
  const stale = day > 14;

  if (sec < 60) return { label: "Just now", stale };
  if (min < 60) return { label: `${min}m ago`, stale };
  if (hr < 24) return { label: `${hr}h ago`, stale };
  if (day === 1) return { label: "Yesterday", stale };
  if (day < 7) return { label: `${day}d ago`, stale };
  if (day < 30) return { label: `${Math.floor(day / 7)}w ago`, stale };

  const d = new Date(iso);
  const monthDay = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  if (d.getFullYear() === now.getFullYear()) return { label: monthDay, stale };
  return { label: `${monthDay}, ${d.getFullYear()}`, stale };
}
