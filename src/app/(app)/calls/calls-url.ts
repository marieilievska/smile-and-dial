export type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Build a /calls URL from the current params plus overrides. An override of
 * an empty string or undefined removes that param.
 */
export function callsHref(
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
  return qs ? `/calls?${qs}` : "/calls";
}
