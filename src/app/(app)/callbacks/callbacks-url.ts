/** URL helpers for the /callbacks list page.
 *
 *  Mirrors src/app/(app)/calls/calls-url.ts. The page is fully URL-
 *  driven — status tab, filter popover, date range, and sort all
 *  round-trip through the query string so:
 *   - Saved-view URLs are shareable
 *   - The browser back button restores filter state
 *   - Server components can read the params synchronously
 */

export type SearchParams = Record<string, string | string[] | undefined>;

/** Build a /callbacks URL from the current params plus overrides. An
 *  override of an empty string or undefined removes that param. */
export function callbacksHref(
  current: SearchParams,
  overrides: Record<string, string | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(current)) {
    if (typeof value === "string" && value) params.set(key, value);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === "") params.delete(key);
    else params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `/callbacks?${qs}` : "/callbacks";
}

/** Read a string param, defaulting to "" if missing or array-valued. */
export function str(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

/** Allowed sort keys → DB column names. Anything else falls back to
 *  scheduled_at ascending (the natural action-queue ordering). */
export const CALLBACK_SORT_COLUMNS: Record<string, string> = {
  scheduled_at: "scheduled_at",
  status: "status",
  company: "lead.company",
};

export function parseSort(params: SearchParams): {
  sort: string;
  dir: "asc" | "desc";
} {
  const raw = str(params.sort);
  const dir = str(params.dir) === "desc" ? "desc" : "asc";
  if (raw && CALLBACK_SORT_COLUMNS[raw]) return { sort: raw, dir };
  return { sort: "scheduled_at", dir: "asc" };
}
