/** Tiny relative-time formatter shared across the app. Round 32
 *  (G2) — promoted from the two near-identical copies that lived in
 *  notification-bell.tsx and lead activity-feed.tsx into a single
 *  helper so every "moment ago" surface tells time the same way.
 *
 *  Truncates rather than rounds: "59m ago" stays at 59m until the
 *  60th minute, then flips to "1h ago". Past 14 days, we fall back
 *  to a locale date so the chrome doesn't grow unbounded.
 *
 *  All inputs are ISO strings (Supabase columns and JSON timestamps
 *  alike); a null/undefined input returns the supplied fallback so
 *  callers don't have to ternary at the call site. */
export function relativeTime(
  iso: string | null | undefined,
  fallback = "—",
): string {
  if (!iso) return fallback;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return fallback;
  const now = Date.now();
  const sec = Math.max(1, Math.floor((now - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Slightly more conversational variant: "just now" / "5 minutes ago"
 *  / "2 hours ago". Used in places where the chrome has room and the
 *  curt form (`5m ago`) would feel terse — notification toasts, lead
 *  detail "last viewed" chips, action queue subtitles. */
export function relativeTimeLong(
  iso: string | null | undefined,
  fallback = "—",
): string {
  if (!iso) return fallback;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return fallback;
  const now = Date.now();
  const sec = Math.max(1, Math.floor((now - then) / 1000));
  if (sec < 30) return "just now";
  if (sec < 60) return `${sec} seconds ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${day} day${day === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}
