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

/** Bidirectional short relative time. Past renders "2h ago", future
 *  renders "in 2h" — same truncating buckets as relativeTime. Used by
 *  the Leads table for "Last call" (past) and "Next call" (future) so a
 *  single helper covers both directions. Past 14 days either way, falls
 *  back to a locale date. */
export function relativeTimeSigned(
  iso: string | null | undefined,
  fallback = "—",
): string {
  if (!iso) return fallback;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return fallback;
  const diff = then - Date.now(); // > 0 = in the future
  const future = diff >= 0;
  const wrap = (s: string) => (future ? `in ${s}` : `${s} ago`);
  const sec = Math.max(1, Math.floor(Math.abs(diff) / 1000));
  if (sec < 60) return wrap(`${sec}s`);
  const min = Math.floor(sec / 60);
  if (min < 60) return wrap(`${min}m`);
  const hr = Math.floor(min / 60);
  if (hr < 24) return wrap(`${hr}h`);
  const day = Math.floor(hr / 24);
  if (day < 14) return wrap(`${day}d`);
  return new Date(iso).toLocaleDateString();
}

/** Full, exact timestamp for hover tooltips — pairs with the relative
 *  helpers so the precise value (which the dialer actually reads for
 *  "Next call") is always one hover away. */
export function exactDateTime(
  iso: string | null | undefined,
  fallback = "",
): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return fallback;
  return d.toLocaleString();
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
