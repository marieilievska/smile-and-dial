// tests/number-pool.unit.test.ts
import { describe, it, expect } from "vitest";
import {
  areaCodeOf,
  effectiveDailyCap,
  pickPoolNumber,
  type PoolCandidate,
} from "../src/lib/dialer/number-pool";

const DAY = 86_400_000;
const NOW = 1_760_000_000_000; // fixed clock

function cand(p: Partial<PoolCandidate>): PoolCandidate {
  return {
    id: "n1",
    elevenlabsPhoneNumberId: "phnum_1",
    areaCode: "954",
    calls24h: 0,
    effectiveCap: 100,
    connectRate: null,
    ...p,
  };
}

describe("areaCodeOf", () => {
  it("parses a US E.164 number", () => {
    expect(areaCodeOf("+19543357483")).toBe("954");
  });
  it("returns null for non-US / malformed", () => {
    expect(areaCodeOf("+447911123456")).toBeNull();
    expect(areaCodeOf("")).toBeNull();
    expect(areaCodeOf(null)).toBeNull();
  });
});

describe("effectiveDailyCap (warm-up ramp)", () => {
  const base = { matureCap: 100, warmupStartCap: 20, warmupDays: 14, now: NOW };
  it("returns the mature cap once warm-up is over", () => {
    expect(
      effectiveDailyCap({
        ...base,
        warmupStartedAt: new Date(NOW - 20 * DAY).toISOString(),
      }),
    ).toBe(100);
  });
  it("returns the start cap on day 0", () => {
    expect(
      effectiveDailyCap({
        ...base,
        warmupStartedAt: new Date(NOW).toISOString(),
      }),
    ).toBe(20);
  });
  it("ramps linearly at the halfway point", () => {
    expect(
      effectiveDailyCap({
        ...base,
        warmupStartedAt: new Date(NOW - 7 * DAY).toISOString(),
      }),
    ).toBe(60);
  });
  it("treats a null warm-up start as mature", () => {
    expect(effectiveDailyCap({ ...base, warmupStartedAt: null })).toBe(100);
  });
});

describe("pickPoolNumber", () => {
  it("prefers an exact area-code match over a less-used other-area number", () => {
    const chosen = pickPoolNumber(
      [
        cand({ id: "other", areaCode: "212", calls24h: 0 }),
        cand({ id: "local", areaCode: "954", calls24h: 30 }),
      ],
      "954",
      "leadA",
    );
    expect(chosen?.id).toBe("local");
  });
  it("falls back to any least-used when no area-code match", () => {
    const chosen = pickPoolNumber(
      [
        cand({ id: "a", areaCode: "212", calls24h: 40 }),
        cand({ id: "b", areaCode: "305", calls24h: 10 }),
      ],
      "954",
      "leadA",
    );
    expect(chosen?.id).toBe("b");
  });
  it("excludes numbers at or over their effective cap", () => {
    const chosen = pickPoolNumber(
      [
        cand({ id: "full", areaCode: "954", calls24h: 100, effectiveCap: 100 }),
        cand({ id: "ok", areaCode: "305", calls24h: 5, effectiveCap: 100 }),
      ],
      "954",
      "leadA",
    );
    expect(chosen?.id).toBe("ok");
  });
  it("returns null when every number is capped (pool exhausted)", () => {
    const chosen = pickPoolNumber(
      [cand({ id: "x", calls24h: 100, effectiveCap: 100 })],
      "954",
      "leadA",
    );
    expect(chosen).toBeNull();
  });
  it("breaks a usage tie by higher connect rate", () => {
    const chosen = pickPoolNumber(
      [
        cand({ id: "low", areaCode: "954", calls24h: 10, connectRate: 0.1 }),
        cand({ id: "high", areaCode: "954", calls24h: 10, connectRate: 0.3 }),
      ],
      "954",
      "leadA",
    );
    expect(chosen?.id).toBe("high");
  });
});
