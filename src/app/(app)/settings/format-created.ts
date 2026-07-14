import { etDayString } from "@/lib/time/eastern";

const TZ = "America/New_York";

/** Humanize a `created_at` (or any past) timestamp for the settings
 *  tables. Same shape as DNC `formatAddedAt` — recent rows read as
 *  relative ("3h ago"), older ones get a concrete date. Pure function —
 *  pass `now` to keep the render deterministic.
 *
 *  Day buckets (Today/Yesterday/weekday) and the displayed dates use Eastern
 *  calendar days — the app-wide convention — so labels don't flip a few hours
 *  early on the server's UTC clock. Centralised here so every settings page
 *  uses the same convention. */
export function formatCreatedAt(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const deltaMs = now.getTime() - at.getTime();
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    return at.toLocaleDateString(undefined, { timeZone: TZ });
  }
  const min = Math.floor(deltaMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  // Whole-day delta in Eastern calendar days.
  const [ay, am, ad] = etDayString(at).split("-").map(Number);
  const [ny, nm, nd] = etDayString(now).split("-").map(Number);
  const dayDelta = Math.round(
    (Date.UTC(ny, nm - 1, nd) - Date.UTC(ay, am - 1, ad)) / 86_400_000,
  );
  if (dayDelta === 0) {
    const h = Math.floor(min / 60);
    return `${h}h ago`;
  }
  if (dayDelta === 1) return "Yesterday";
  if (dayDelta < 7) {
    return at.toLocaleDateString(undefined, { weekday: "short", timeZone: TZ });
  }
  if (ay === ny) {
    return at.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      timeZone: TZ,
    });
  }
  return at.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: TZ,
  });
}
