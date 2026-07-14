import { describe, expect, it } from "vitest";
import { chunk } from "../src/lib/review/chunk";

describe("chunk", () => {
  it("splits into fixed-size batches, last one short", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns one batch when smaller than the size", () => {
    expect(chunk([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  });

  it("returns no batches for an empty array", () => {
    expect(chunk([], 3)).toEqual([]);
  });

  it("splits exactly when evenly divisible", () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("defaults to a batch size of 500", () => {
    const ids = Array.from({ length: 1200 }, (_, i) => i);
    const batches = chunk(ids);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(500);
    expect(batches[2]).toHaveLength(200);
  });

  it("rejects a non-positive size", () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});
