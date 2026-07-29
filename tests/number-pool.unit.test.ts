// tests/number-pool.unit.test.ts
import { describe, it, expect } from "vitest";
import {
  areaCodeOf,
  effectiveDailyCap,
  pickPoolNumber,
  UNCAPPED,
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

describe("effectiveDailyCap (capping turned off)", () => {
  // daily_cap <= 0 means "no per-number ceiling" pool-wide.
  const off = { matureCap: 0, warmupStartCap: 50, warmupDays: 14, now: NOW };

  it("returns UNCAPPED for a zero mature cap", () => {
    expect(effectiveDailyCap({ ...off, warmupStartedAt: null })).toBe(UNCAPPED);
  });

  it("returns UNCAPPED for a negative mature cap", () => {
    expect(
      effectiveDailyCap({ ...off, matureCap: -1, warmupStartedAt: null }),
    ).toBe(UNCAPPED);
  });

  it("skips the warm-up ramp entirely when uncapped", () => {
    // The ramp is checked AFTER the uncapped short-circuit on purpose: reading
    // it first would floor a brand-new number at warmupStartCap (50) and
    // silently reintroduce a cap we turned off.
    expect(
      effectiveDailyCap({
        ...off,
        warmupStartedAt: new Date(NOW).toISOString(),
      }),
    ).toBe(UNCAPPED);
  });

  it("still honours a per-number override when the pool default is off", () => {
    expect(
      effectiveDailyCap({ ...off, matureCap: 25, warmupStartedAt: null }),
    ).toBe(25);
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
  it("never exhausts an uncapped pool, however many calls it has taken", () => {
    const chosen = pickPoolNumber(
      [cand({ id: "busy", calls24h: 50_000, effectiveCap: UNCAPPED })],
      "954",
      "leadA",
    );
    expect(chosen?.id).toBe("busy");
  });
  it("still spreads load across uncapped numbers, least-used first", () => {
    // Removing the ceiling must not collapse onto one number — the least-used
    // ordering is what keeps volume even across the pool.
    const chosen = pickPoolNumber(
      [
        cand({
          id: "hot",
          areaCode: "954",
          calls24h: 900,
          effectiveCap: UNCAPPED,
        }),
        cand({
          id: "cool",
          areaCode: "954",
          calls24h: 12,
          effectiveCap: UNCAPPED,
        }),
      ],
      "954",
      "leadA",
    );
    expect(chosen?.id).toBe("cool");
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
  it("prefers a same-state number over a less-used out-of-state number when no exact area-code match", () => {
    // Lead is in 954 (FL). No 954 number is under cap, but a 754 (also FL)
    // and a 212 (NY) both are. Same-state (754) must win over out-of-state
    // (212) even though 212 is less-used.
    const chosen = pickPoolNumber(
      [
        cand({ id: "ny", areaCode: "212", calls24h: 0 }),
        cand({ id: "fl-other", areaCode: "754", calls24h: 30 }),
      ],
      "954",
      "leadA",
    );
    expect(chosen?.id).toBe("fl-other");
  });
  it("still prefers exact area-code match over a same-state match", () => {
    const chosen = pickPoolNumber(
      [
        cand({ id: "fl-exact", areaCode: "954", calls24h: 30 }),
        cand({ id: "fl-other", areaCode: "754", calls24h: 0 }),
      ],
      "954",
      "leadA",
    );
    expect(chosen?.id).toBe("fl-exact");
  });
});

describe("pickPoolNumber match tier", () => {
  it("reports 'exact' when the area code matches", () => {
    const picked = pickPoolNumber(
      [cand({ id: "a", areaCode: "954" }), cand({ id: "b", areaCode: "213" })],
      "954",
      "seed",
    );
    expect(picked?.id).toBe("a");
    expect(picked?.matchTier).toBe("exact");
  });

  it("reports 'state' when only a same-state number is available", () => {
    // 754 is Florida, same state as the 954 lead, different area code.
    const picked = pickPoolNumber(
      [cand({ id: "a", areaCode: "754" }), cand({ id: "b", areaCode: "213" })],
      "954",
      "seed",
    );
    expect(picked?.id).toBe("a");
    expect(picked?.matchTier).toBe("state");
  });

  it("reports 'none' when nothing is local", () => {
    const picked = pickPoolNumber(
      [cand({ id: "b", areaCode: "213" })],
      "954",
      "seed",
    );
    expect(picked?.id).toBe("b");
    expect(picked?.matchTier).toBe("none");
  });

  it("reports 'none' when the lead area code is unknown", () => {
    const picked = pickPoolNumber(
      [cand({ id: "b", areaCode: "213" })],
      null,
      "seed",
    );
    expect(picked?.matchTier).toBe("none");
  });
});
