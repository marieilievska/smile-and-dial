import { test, expect } from "@playwright/test";
import { buildRubricText } from "../src/lib/review/rubric";
import { mergeVerification } from "../src/lib/review/analyze";

test("buildRubricText renders key/lens/label/guidance per line", () => {
  const text = buildRubricText([
    {
      key: "tool_error",
      label: "Tool error",
      lens: "bug",
      severity: 1,
      guidance: "A tool failed.",
    },
  ]);
  expect(text).toContain("tool_error (bug): Tool error. A tool failed.");
});

test("mergeVerification confirms agreed flags and flags disagreements for review", () => {
  const proposed = [
    {
      flag_key: "tool_error",
      evidence_quote: "the system errored",
      confidence: 0.9,
    },
    {
      flag_key: "price_objection",
      evidence_quote: "too expensive",
      confidence: 0.8,
    },
    { flag_key: "off_goal", evidence_quote: "n/a", confidence: 0.4 },
  ];
  const verdicts = {
    tool_error: {
      agree: true,
      confidence: 0.95,
      evidence_quote: "the system errored out",
    },
    price_objection: { agree: false, confidence: 0.9, evidence_quote: "" },
    off_goal: { agree: true, confidence: 0.5, evidence_quote: "n/a" },
  };
  const merged = mergeVerification(proposed, verdicts);
  expect(merged.find((f) => f.flag_key === "tool_error")).toMatchObject({
    status: "confirmed",
    evidence_quote: "the system errored out",
  });
  expect(merged.find((f) => f.flag_key === "price_objection")).toBeUndefined();
  expect(merged.find((f) => f.flag_key === "off_goal")).toMatchObject({
    status: "needs_review",
  });
});
