/** Max ids per request for `.in("id", …)` filters. A "select all matching"
 *  sweep can carry thousands of ids; sending them in one filter overflows the
 *  request URL and the whole query fails. Chunking keeps each request well
 *  under that limit. Shared by the leads bulk-actions and DNC bulk-add so the
 *  two never drift apart on this boundary. */
export const ID_CHUNK = 200;

/** Split an array into fixed-size chunks. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
