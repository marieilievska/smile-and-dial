import { describe, expect, test } from "vitest";

import {
  dialCap,
  effectiveDailyCap,
  pickPoolNumber,
  UNCAPPED,
  type PoolCandidate,
} from "@/lib/dialer/number-pool";

const warmup = {
  matureCap: 100,
  warmupStartCap: 50,
  warmupDays: 14,
  // Bought ~10h ago — deep in warm-up, so the ramped cap is ~51.
  warmupStartedAt: "2026-08-10T10:00:00.000Z",
  now: new Date("2026-08-10T20:00:00.000Z").getTime(),
};

describe("dialCap — scheduled callbacks bypass the per-number warm-up/daily cap", () => {
  test("a callback dial is uncapped", () => {
    expect(dialCap({ ...warmup, bypassCap: true })).toBe(UNCAPPED);
  });

  test("a cold dial uses the warm-up-ramped cap (unchanged behaviour)", () => {
    expect(dialCap({ ...warmup, bypassCap: false })).toBe(
      effectiveDailyCap(warmup),
    );
  });
});

describe("pickPoolNumber — a fully capped pool", () => {
  const cand = (
    id: string,
    calls24h: number,
    effectiveCap: number,
  ): PoolCandidate => ({
    id,
    elevenlabsPhoneNumberId: `pn_${id}`,
    areaCode: "305",
    calls24h,
    effectiveCap,
    connectRate: null,
  });

  test("cold dial: every number over its cap → pool exhausted (null)", () => {
    const pool = [cand("a", 60, 51), cand("b", 55, 51)];
    expect(pickPoolNumber(pool, "305", "lead1")).toBeNull();
  });

  test("callback dial (cap bypassed → UNCAPPED): still yields the least-used number", () => {
    const pool = [cand("a", 60, UNCAPPED), cand("b", 55, UNCAPPED)];
    expect(pickPoolNumber(pool, "305", "lead1")?.id).toBe("b");
  });
});
