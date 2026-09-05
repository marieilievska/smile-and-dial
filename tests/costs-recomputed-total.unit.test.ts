import { describe, expect, test } from "vitest";

import {
  breakdownTotal,
  componentSum,
  pickBreakdown,
  withRecomputedTotal,
} from "../src/lib/costs/breakdown";

/**
 * withRecomputedTotal is the ONE way a `cost_breakdown` gets its `total`.
 * The objection worker used to bump `openai` without touching `total`, which
 * left 1,183 of 7,888 calls with a stale stored total — and the Calls list,
 * the call modal, pre_call_check and the spend-cap monitor all read the
 * stored total. These pin the definition every writer now shares.
 */
describe("withRecomputedTotal", () => {
  test("total = twilio + elevenlabs + openai + openai_review + lookup", () => {
    const out = withRecomputedTotal({
      twilio: 0.02,
      elevenlabs: 0.05,
      openai: 0.01,
      openai_review: 0.03,
      lookup: 0.008,
    });
    expect(out.total).toBeCloseTo(0.118, 4);
  });

  test("replaces a stale stored total instead of trusting it", () => {
    const out = withRecomputedTotal({
      twilio: 0.02,
      elevenlabs: 0.05,
      openai: 0.02, // bumped by the objection worker …
      total: 0.07, // … without recomputing this
    });
    expect(out.total).toBeCloseTo(0.09, 4);
  });

  test("does NOT sum the sub-part or credit keys (no double counting)", () => {
    const out = withRecomputedTotal({
      twilio: 0.03,
      twilio_call: 0.02,
      twilio_media_stream: 0.01,
      elevenlabs: 0.1,
      elevenlabs_llm: 0.04,
      elevenlabs_voice: 0.06,
      elevenlabs_credits: 633,
      elevenlabs_llm_credits: 253,
      elevenlabs_voice_credits: 380,
    });
    expect(out.total).toBeCloseTo(0.13, 4);
  });

  test("keeps a legacy un-itemized total when there are no components", () => {
    const out = withRecomputedTotal({ total: 0.42 });
    expect(out.total).toBeCloseTo(0.42, 4);
  });

  test("preserves every other key and does not mutate its input", () => {
    const input = { twilio: 0.02, openai: 0.01, note: "x", total: 1 };
    const out = withRecomputedTotal(input);
    expect(out.note).toBe("x");
    expect(out.twilio).toBe(0.02);
    expect(input.total).toBe(1);
    expect(out.total).toBeCloseTo(0.03, 4);
  });

  test("rounds to 4 decimal places", () => {
    const out = withRecomputedTotal({ twilio: 0.01234567, elevenlabs: 0.1 });
    expect(out.total).toBe(0.1123);
  });

  test("ignores non-numeric component values", () => {
    const out = withRecomputedTotal({
      twilio: "0.5" as unknown as number,
      elevenlabs: 0.1,
    });
    expect(out.total).toBeCloseTo(0.1, 4);
  });
});

describe("breakdownTotal / componentSum agree with pickBreakdown", () => {
  test("the three read the same number off the same row", () => {
    const row = {
      twilio: 0.02,
      elevenlabs: 0.05,
      openai_review: 0.01,
      total: 0,
    };
    expect(componentSum(row)).toBeCloseTo(0.08, 4);
    expect(breakdownTotal(row)).toBeCloseTo(0.08, 4);
    expect(pickBreakdown(row).total).toBeCloseTo(0.08, 4);
  });

  test("non-objects are zero", () => {
    expect(breakdownTotal(null)).toBe(0);
    expect(breakdownTotal("x")).toBe(0);
    expect(pickBreakdown(undefined).total).toBe(0);
  });

  test("a written row round-trips through pickBreakdown unchanged", () => {
    const written = withRecomputedTotal({
      twilio: 0.0164,
      elevenlabs: 0.0999,
      openai: 0.002,
      lookup: 0,
    });
    expect(pickBreakdown(written).total).toBeCloseTo(written.total, 4);
  });
});
