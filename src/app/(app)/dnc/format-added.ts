import { etPastLabel } from "@/lib/time/eastern";

/** Humanize the `added_at` timestamp for the DNC table. Reads cleaner
 *  than a raw `M/D/YYYY` for recent rows, while keeping a concrete date
 *  for older ones so the eye doesn't have to guess. Eastern days.
 *
 *  Outputs: "just now" / "12m ago" / "3h ago" / "Yesterday" / "Tue" /
 *  "May 12" / "May 12, 2024". Pure — pass `now` for deterministic tests. */
export function formatAddedAt(
  addedAtIso: string,
  now: Date = new Date(),
): string {
  return etPastLabel(addedAtIso, now);
}
