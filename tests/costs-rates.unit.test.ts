import { test, expect, describe } from "vitest";
import {
  priceOpenAiTokens,
  twilioNumberMonthlyUsd,
} from "../src/lib/costs/rates";

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

/**
 * Number rental is priced PER COUNTRY. The account's negotiated $0.04 covers US
 * local numbers only; Canadian local numbers bill at the full $1.15 list price.
 *
 * Confirmed three ways on 2026-09-09 — the Pricing API under the parent, under
 * the subaccount, and the account's own `phonenumbers-local` usage record,
 * which billed $12.27 for 48 US + 9 Canadian numbers. 48 × 0.04 + 9 × 1.15 =
 * 12.27 exactly.
 *
 * One flat rate was harmless while the pool was US-only. The day nine Canadian
 * numbers were bought it under-reported rental by 438% — $2.28 recorded against
 * $12.27 billed — and carried that error into the Costs page headline, because
 * `numberRentalInPeriod` sums `twilio_numbers.monthly_cost`.
 */
describe("twilioNumberMonthlyUsd is country-aware", () => {
  test("US local numbers use the negotiated rate", () => {
    expect(twilioNumberMonthlyUsd("US")).toBe(0.04);
  });

  test("Canadian local numbers bill at full list price", () => {
    expect(twilioNumberMonthlyUsd("CA")).toBe(1.15);
  });

  test("the two are NOT the same — the discount is US-only", () => {
    expect(twilioNumberMonthlyUsd("CA")).not.toBe(twilioNumberMonthlyUsd("US"));
  });

  test("defaults to US when the caller does not say", () => {
    expect(twilioNumberMonthlyUsd()).toBe(0.04);
  });

  test("reproduces the real bill for the mixed pool", () => {
    const billed =
      48 * twilioNumberMonthlyUsd("US") + 9 * twilioNumberMonthlyUsd("CA");
    // Twilio's own usage record for 2026-09-09.
    expect(Number(billed.toFixed(2))).toBe(12.27);
  });
});
