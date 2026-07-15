import { describe, expect, it } from "vitest";

import {
  OFF_SCRIPT_KEY,
  isCacheStale,
  rubricDefsForReview,
  truncateInstructions,
} from "../src/lib/review/instructions";
import type { ReviewFlagDef } from "../src/lib/review/types";

const def = (key: string): ReviewFlagDef => ({
  key,
  label: key,
  lens: "quality",
  severity: 3,
  guidance: key,
});

describe("rubricDefsForReview", () => {
  const defs = [def("tool_error"), def(OFF_SCRIPT_KEY)];
  it("keeps off_script when instructions are present", () => {
    expect(rubricDefsForReview(defs, true).map((d) => d.key)).toEqual([
      "tool_error",
      OFF_SCRIPT_KEY,
    ]);
  });
  it("drops off_script when instructions are absent", () => {
    expect(rubricDefsForReview(defs, false).map((d) => d.key)).toEqual([
      "tool_error",
    ]);
  });
});

describe("truncateInstructions", () => {
  it("returns short text unchanged", () => {
    expect(truncateInstructions("hi", 10)).toBe("hi");
  });
  it("caps long text at the limit", () => {
    expect(truncateInstructions("abcdefghij", 5)).toBe("abcde");
  });
  it("passes null through", () => {
    expect(truncateInstructions(null, 5)).toBeNull();
  });
});

describe("isCacheStale", () => {
  const now = 1_000_000_000_000;
  it("stale when never cached", () => {
    expect(isCacheStale(null, now, 7)).toBe(true);
  });
  it("fresh within the window", () => {
    const oneDayAgo = new Date(now - 24 * 3600_000).toISOString();
    expect(isCacheStale(oneDayAgo, now, 7)).toBe(false);
  });
  it("stale past the window", () => {
    const tenDaysAgo = new Date(now - 10 * 24 * 3600_000).toISOString();
    expect(isCacheStale(tenDaysAgo, now, 7)).toBe(true);
  });
});
