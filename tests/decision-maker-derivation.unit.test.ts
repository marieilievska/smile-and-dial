import { describe, expect, it } from "vitest";

import { anyCallReachedDm, outcomeImpliesDm } from "@/lib/calls/decision-maker";

describe("outcomeImpliesDm", () => {
  it("treats not_interested as reaching the decision-maker (by definition)", () => {
    // The disposition prompt defines not_interested as "the DECISION MAKER …
    // clearly declined", so it always means we reached them.
    expect(outcomeImpliesDm("not_interested")).toBe(true);
  });

  it("does NOT treat a gatekeeper or callback as reaching the decision-maker", () => {
    expect(outcomeImpliesDm("gatekeeper")).toBe(false);
    expect(outcomeImpliesDm("callback")).toBe(false);
  });

  it("does NOT infer a decision-maker from goal_met (a goal can be met without one)", () => {
    expect(outcomeImpliesDm("goal_met")).toBe(false);
  });

  it("is false for null / unknown outcomes", () => {
    expect(outcomeImpliesDm(null)).toBe(false);
    expect(outcomeImpliesDm(undefined)).toBe(false);
    expect(outcomeImpliesDm("voicemail")).toBe(false);
  });
});

describe("anyCallReachedDm", () => {
  it("is true when a call's outcome definitionally implies a decision-maker", () => {
    expect(
      anyCallReachedDm([{ extracted_data: {}, outcome: "not_interested" }]),
    ).toBe(true);
  });

  it("is true when the AI flagged the decision-maker on a non-gatekeeper call", () => {
    expect(
      anyCallReachedDm([
        {
          extracted_data: { decision_maker_reached: "yes" },
          outcome: "goal_met",
        },
      ]),
    ).toBe(true);
  });

  it("VETOES a gatekeeper the AI mis-flagged as the decision-maker", () => {
    // A gatekeeper is a non-owner by definition, so a stray flag must not count.
    expect(
      anyCallReachedDm([
        {
          extracted_data: { decision_maker_reached: "yes" },
          outcome: "gatekeeper",
        },
      ]),
    ).toBe(false);
    expect(
      anyCallReachedDm([
        {
          extracted_data: { decision_maker_reached: "yes" },
          outcome: "gatekeeper_not_interested",
        },
      ]),
    ).toBe(false);
  });

  it("is false when neither the flag nor the outcome implies a decision-maker", () => {
    expect(
      anyCallReachedDm([
        {
          extracted_data: { decision_maker_reached: "no" },
          outcome: "gatekeeper",
        },
        { extracted_data: {}, outcome: "goal_met" },
      ]),
    ).toBe(false);
  });

  it("still works when outcome is omitted (extraction-only callers)", () => {
    expect(
      anyCallReachedDm([{ extracted_data: { decision_maker_reached: "yes" } }]),
    ).toBe(true);
    expect(anyCallReachedDm([{ extracted_data: {} }])).toBe(false);
  });
});
