// tests/chunk-parallel.unit.test.ts
import { describe, expect, it } from "vitest";

import { CHUNK_CONCURRENCY, chunk, mapChunks } from "@/lib/leads/chunk";

describe("chunk", () => {
  it("splits into fixed-size chunks, last one short", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns [] for an empty input", () => {
    expect(chunk([], 10)).toEqual([]);
  });
});

describe("mapChunks", () => {
  it("returns results in CHUNK order even when they finish out of order", async () => {
    // First chunk resolves last. Completion order must not leak into results.
    const out = await mapChunks([1, 2, 3, 4], 2, async (c) => {
      await new Promise((r) => setTimeout(r, c[0] === 1 ? 20 : 1));
      return c.map((n) => n * 10);
    });
    expect(out).toEqual([
      [10, 20],
      [30, 40],
    ]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 40 }, (_, i) => i);

    await mapChunks(
      items,
      1, // 40 chunks, so the limiter is definitely exercised
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight -= 1;
        return null;
      },
      4,
    );

    expect(peak).toBeLessThanOrEqual(4);
    // Sanity: it really did run things in parallel, not one at a time.
    expect(peak).toBeGreaterThan(1);
  });

  it("runs every chunk exactly once", async () => {
    const seen: number[] = [];
    await mapChunks(
      Array.from({ length: 25 }, (_, i) => i),
      5,
      async (c) => {
        seen.push(...c);
        return null;
      },
    );
    expect(seen.sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, i) => i),
    );
  });

  it("handles an empty input without spawning workers", async () => {
    let calls = 0;
    const out = await mapChunks([], 10, async () => {
      calls += 1;
      return 1;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it("propagates a rejection from any chunk", async () => {
    await expect(
      mapChunks([1, 2, 3, 4], 2, async (c) => {
        if (c[0] === 3) throw new Error("chunk blew up");
        return c;
      }),
    ).rejects.toThrow("chunk blew up");
  });

  it("defaults to the shared concurrency cap", () => {
    expect(CHUNK_CONCURRENCY).toBe(6);
  });
});
