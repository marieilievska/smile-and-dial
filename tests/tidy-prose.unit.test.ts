// tests/tidy-prose.unit.test.ts
import { describe, expect, it } from "vitest";

import { tidyProse } from "@/lib/ai/tidy-prose";

describe("tidyProse", () => {
  it("returns blank input unchanged (no key needed)", async () => {
    expect(await tidyProse("   ")).toBe("   ");
  });
});
