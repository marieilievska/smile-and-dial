/** Split an array into fixed-size chunks. Used to keep bulk PostgREST
 *  `.in(...)` reads/writes under the URI-length and 1,000-row response limits
 *  (a single `.in([...])` with thousands of ids 414s or silently truncates). */
export function chunk<T>(arr: readonly T[], size = 500): T[][] {
  if (size <= 0) throw new Error("chunk size must be > 0");
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
