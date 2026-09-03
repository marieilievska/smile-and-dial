import { etPastLabel } from "@/lib/time/eastern";

/** Humanize a `created_at` (or any past) timestamp for the settings
 *  tables. Same shape as DNC `formatAddedAt` — recent rows read as
 *  relative ("3h ago"), older ones get a concrete date, bucketed by
 *  Eastern calendar day (the app-wide convention). Pure — pass `now`. */
export function formatCreatedAt(iso: string, now: Date = new Date()): string {
  return etPastLabel(iso, now);
}
