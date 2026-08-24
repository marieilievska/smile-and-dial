import { afterEach, describe, expect, it } from "vitest";
import { creditConfig } from "@/lib/elevenlabs/credit-config";

const KEYS = [
  "EL_CREDIT_WARN_THRESHOLD",
  "EL_CREDIT_STOP_THRESHOLD",
  "EL_CREDIT_RESUME_THRESHOLD",
  "EL_AVG_CREDITS_PER_CALL",
];

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe("creditConfig", () => {
  it("returns the balanced defaults when no env is set", () => {
    expect(creditConfig()).toEqual({
      warn: 100_000,
      stop: 35_000,
      resume: 50_000,
      avgCreditsPerCall: 530,
    });
  });

  it("honors env overrides", () => {
    process.env.EL_CREDIT_STOP_THRESHOLD = "80000";
    process.env.EL_AVG_CREDITS_PER_CALL = "600";
    const cfg = creditConfig();
    expect(cfg.stop).toBe(80_000);
    expect(cfg.avgCreditsPerCall).toBe(600);
  });

  it("ignores a negative or non-numeric override and uses the default", () => {
    process.env.EL_CREDIT_WARN_THRESHOLD = "-5";
    process.env.EL_CREDIT_RESUME_THRESHOLD = "abc";
    const cfg = creditConfig();
    expect(cfg.warn).toBe(100_000);
    expect(cfg.resume).toBe(50_000);
  });
});
