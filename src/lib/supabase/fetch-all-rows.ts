/**
 * Page past PostgREST's hard 1,000-row response cap.
 *
 * This project's PostgREST is configured with `max_rows = 1000`
 * (supabase/config.toml): EVERY response is truncated to 1,000 rows, and a
 * bare `.limit(5000)` is silently clamped to 1,000 as well. Any query whose
 * rows are then counted or summed in JS therefore under-reports the moment a
 * table, day, or window passes 1,000 rows — with no error and no sign in the
 * UI. Route every such read through here so it pages instead.
 *
 * `page(from, to)` builds the query for one inclusive row range — put
 * `.range(from, to)` at the END of it (after every filter and the `.order`,
 * which must be present and deterministic so pages don't overlap). Stops on
 * the first short page; `max` is a safety ceiling on rows fetched.
 */
export async function fetchAllRows<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null }>,
  opts: { pageSize?: number; max?: number } = {},
): Promise<T[]> {
  const size = opts.pageSize ?? 1000;
  const max = opts.max ?? 500_000;
  const rows: T[] = [];
  for (let from = 0; from < max; from += size) {
    const { data } = await page(from, from + size - 1);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < size) break;
  }
  return rows;
}
