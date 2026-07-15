import { test, expect, describe } from "vitest";
import { priceOpenAiTokens } from "../src/lib/costs/rates";

// 1M prompt + 1M completion makes each model's price its (input + output)
// per-1M rate, so the assertions read as the published USD/1M numbers.
const M = 1_000_000;

describe("priceOpenAiTokens is model-aware", () => {
  test("gpt-5.4 uses the gpt-5.4 rate (2.50 in + 15.00 out)", () => {
    expect(priceOpenAiTokens(M, M, "gpt-5.4")).toBe(17.5);
  });

  test("gpt-5.4-mini uses the mini rate (0.75 in + 4.50 out)", () => {
    expect(priceOpenAiTokens(M, M, "gpt-5.4-mini")).toBe(5.25);
  });

  test("the more specific -mini prefix wins over the bare gpt-5.4 prefix", () => {
    // If -mini were matched by the gpt-5.4 branch it would price at 17.5.
    expect(priceOpenAiTokens(M, M, "gpt-5.4-mini")).toBe(5.25);
  });

  test("versioned/dated model names still resolve by prefix", () => {
    expect(priceOpenAiTokens(M, M, "gpt-5.4-2026-01-01")).toBe(17.5);
    expect(priceOpenAiTokens(M, M, "gpt-5.4-mini-2026-01-01")).toBe(5.25);
  });

  test("gpt-4o-mini and the default both use the legacy 4o-mini rate", () => {
    expect(priceOpenAiTokens(M, M, "gpt-4o-mini")).toBe(0.75);
    expect(priceOpenAiTokens(M, M)).toBe(0.75);
  });

  test("an unknown model falls back to gpt-4o-mini rather than pricing at $0", () => {
    expect(priceOpenAiTokens(M, M, "some-future-model")).toBe(0.75);
  });

  test("negative token counts are floored to zero", () => {
    expect(priceOpenAiTokens(-100, -100, "gpt-5.4")).toBe(0);
  });
});
