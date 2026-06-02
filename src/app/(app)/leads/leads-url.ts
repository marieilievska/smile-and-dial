export type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Build a /leads URL from the current params plus overrides. An override of
 * an empty string or undefined removes that param.
 */
export function leadsHref(
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
  return qs ? `/leads?${qs}` : "/leads";
}

/**
 * Build a /leads/<id> detail URL that carries the current list context
 * (filters, sort, page) so the detail page can offer prev/next through the
 * same view and a Back link that returns to the exact page + filters. An
 * override of an empty string or undefined removes that param.
 */
export function leadDetailHref(
  id: string,
  current: SearchParams,
  overrides: Record<string, string | undefined> = {},
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
  return qs ? `/leads/${id}?${qs}` : `/leads/${id}`;
}
