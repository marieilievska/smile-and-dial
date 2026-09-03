import { describe, expect, it } from "vitest";

import { fetchAllRows } from "@/lib/supabase/fetch-all-rows";

/** PostgREST hard-caps every response at 1,000 rows (supabase/config.toml
 *  max_rows). Any `.select()` that isn't paged is silently truncated — this
 *  helper is the one place that pages, so every count built on it is whole. */
describe("fetchAllRows pages past the 1,000-row cap", () => {
  function fakeTable(total: number, pageSize = 1000) {
    const calls: [number, number][] = [];
    const page = async (from: number, to: number) => {
      calls.push([from, to]);
      const data = Array.from(
        { length: Math.max(0, Math.min(to, total - 1) - from + 1) },
        (_, i) => ({ id: from + i }),
      );
      return { data };
    };
    return { page, calls, pageSize };
  }

  it("concatenates full pages and stops on the first short one", async () => {
    const t = fakeTable(2250);
    const rows = await fetchAllRows(t.page);
    expect(rows).toHaveLength(2250);
    expect(rows[0]).toEqual({ id: 0 });
    expect(rows[2249]).toEqual({ id: 2249 });
    expect(t.calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("makes exactly one request when the first page is short", async () => {
    const t = fakeTable(12);
    const rows = await fetchAllRows(t.page);
    expect(rows).toHaveLength(12);
    expect(t.calls).toHaveLength(1);
  });

  it("returns an empty list for an empty table", async () => {
    const t = fakeTable(0);
    expect(await fetchAllRows(t.page)).toEqual([]);
    expect(t.calls).toHaveLength(1);
  });

  it("treats a null data payload as the end", async () => {
    const rows = await fetchAllRows<{ id: number }>(async () => ({
      data: null,
    }));
    expect(rows).toEqual([]);
  });

  it("honours a custom page size and the safety ceiling", async () => {
    const t = fakeTable(10_000);
    const rows = await fetchAllRows(t.page, { pageSize: 500, max: 2_000 });
    expect(rows).toHaveLength(2000);
    expect(t.calls).toHaveLength(4);
  });
});
