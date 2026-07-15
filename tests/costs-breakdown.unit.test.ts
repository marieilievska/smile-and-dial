import { test, expect, describe } from "vitest";
import { pickBreakdown } from "../src/lib/analytics/costs";

// pickBreakdown feeds the per-call table AND the CSV export, so it must fold the
// Call Reviewer's `openai_review` into the single OpenAI figure the same way the
// cost_rollup_daily SQL does — otherwise those two views would disagree with the
// "Where the money goes" breakdown.
describe("pickBreakdown folds openai_review into the OpenAI line", () => {
  test("openai = call-time openai + reviewer openai_review", () => {
    const b = pickBreakdown({
      twilio: 0.02,
      openai: 0.01,
      openai_review: 0.05,
    });
    expect(b.openai).toBeCloseTo(0.06, 4);
    // total is derived from the components (twilio + openai[incl review]).
    expect(b.total).toBeCloseTo(0.08, 4);
  });

  test("a reviewer-only cost still surfaces (openai present, no call-time openai)", () => {
    const b = pickBreakdown({ elevenlabs: 0.06, openai_review: 0.02 });
    expect(b.openai).toBeCloseTo(0.02, 4);
    expect(b.total).toBeCloseTo(0.08, 4);
  });

  test("total is recomputed to include openai_review, ignoring a stale stored total", () => {
    const b = pickBreakdown({
      elevenlabs: 0.06,
      openai_review: 0.02,
      total: 0.06,
    });
    expect(b.total).toBeCloseTo(0.08, 4);
  });

  test("rows without openai_review are unchanged (backward compatible)", () => {
    const b = pickBreakdown({ twilio: 0.02, openai: 0.01 });
    expect(b.openai).toBeCloseTo(0.01, 4);
    expect(b.total).toBeCloseTo(0.03, 4);
  });

  test("a non-numeric openai_review is ignored, not counted", () => {
    const b = pickBreakdown({ openai: 0.01, openai_review: "oops" });
    expect(b.openai).toBeCloseTo(0.01, 4);
  });
});
