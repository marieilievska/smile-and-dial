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

/** How many chunk requests may be in flight at once.
 *
 *  Not unbounded. A "select all" sweep over 20k leads is 100 chunks, and
 *  `Promise.all` over all of them would open 100 simultaneous PostgREST
 *  requests — enough to saturate the connection pool and make every OTHER
 *  request on the instance queue behind it. Six is comfortably faster than
 *  serial while leaving the pool room to breathe. */
export const CHUNK_CONCURRENCY = 6;

/**
 * Split `items` into chunks and run `fn` over them with bounded concurrency,
 * returning the results IN CHUNK ORDER regardless of completion order.
 *
 * This exists because the chunking itself was always right — a `.in()` filter
 * of ~1,000 UUIDs makes a ~38 KB request URL that PostgREST rejects with a
 * 400, so lookups chunk at ID_CHUNK — but every call site then `await`ed
 * inside a `for` loop, so the round trips ran end to end. On Analytics that
 * turned a few thousand distinct leads into dozens of sequential requests and
 * most of a 7-second render.
 *
 * Use it for READ chunks, which are independent by nature. Deliberately NOT
 * used for the bulk write loops (deletes, status updates, Meta audience
 * pushes): those either have an ordering constraint (`lists/actions.ts` must
 * clear `calls` before `leads` for the RESTRICT foreign key), or an external
 * rate limit, or a partial-failure story that is much easier to reason about
 * when the writes happen in a known order.
 */
export async function mapChunks<T, R>(
  items: T[],
  size: number,
  fn: (chunkItems: T[]) => Promise<R>,
  concurrency: number = CHUNK_CONCURRENCY,
): Promise<R[]> {
  const chunks = chunk(items, size);
  const results = new Array<R>(chunks.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= chunks.length) return;
      results[i] = await fn(chunks[i]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, chunks.length) }, worker),
  );
  return results;
}
