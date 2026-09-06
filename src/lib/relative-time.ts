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
import { etDate, etDateTime, etDateTimeExact } from "@/lib/time/eastern";

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
  return etDate(iso, fallback);
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
  // Round (not floor) at the day scale so 47.8h reads "in 2d", not "in 1d".
  const day = Math.round(hr / 24);
  if (day < 14) return wrap(`${day}d`);
  return etDate(iso, fallback);
}

/** Compact DURATION from a minute count: "<1m", "45m", "3h", "3h 20m",
 *  "1d", "1d 5h".
 *
 *  Distinct from the helpers above, which format a point in time. This one
 *  formats a length of time — "how long has this been overdue".
 *
 *  Rolls over into days past 24h. Without that tier a callback overdue since
 *  yesterday read "29h 19m", and before this helper was shared at all the
 *  Today action queue printed the raw minute count ("1759m overdue") and left
 *  the reader to divide. Shared by the Callbacks list and Today so the same
 *  callback reads the same on both. */
export function humanizeMinutes(min: number): string {
  if (min < 1) return "<1m";
  if (min < 60) return `${min}m`;
  const totalHours = Math.floor(min / 60);
  if (totalHours < 24) {
    const m = min % 60;
    return m === 0 ? `${totalHours}h` : `${totalHours}h ${m}m`;
  }
  const d = Math.floor(totalHours / 24);
  const h = totalHours % 24;
  return h === 0 ? `${d}d` : `${d}d ${h}h`;
}

/** Full, exact timestamp for hover tooltips — pairs with the relative
 *  helpers so the precise value (which the dialer actually reads for
 *  "Next call") is always one hover away. Always Eastern, zone-labelled
 *  ("9/2/2026, 9:43:48 PM EDT"): the team reads every time in ET, even for a
 *  lead on the West Coast. */
export function exactDateTime(
  iso: string | null | undefined,
  fallback = "",
): string {
  return etDateTimeExact(iso, fallback);
}

/** Compact absolute date + clock with the Eastern zone label, for a lead's
 *  "Next call" and similar: "Mar 5, 3:00 PM EDT". The dialer fires in the
 *  LEAD's local time, but the team reads it in ET — a 3pm Pacific callback
 *  shows here as 6:00 PM EDT on purpose. */
export function etClock(iso: string | null | undefined, fallback = ""): string {
  return etDateTime(iso, fallback, true);
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
  return etDate(iso, fallback);
}
