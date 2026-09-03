import { dateRangeLabel, etPastLabel } from "@/lib/time/eastern";

/** Humanize the Started column on the per-call costs table. Matches
 *  the DNC and Today page treatments — recent rows read as "12m ago"
 *  / "3h ago" / "Yesterday", older ones as concrete dates. Eastern days.
 *
 *  Pure function — pass `now` to keep render deterministic in tests. */
export function formatStartedAt(iso: string, now: Date = new Date()): string {
  return etPastLabel(iso, now);
}

/** "May 1 – May 27" humanization for the page header. Same helper as
 *  the analytics page. */
export function fmtRangeLabel(from: string, to: string): string {
  return dateRangeLabel(from, to);
}
