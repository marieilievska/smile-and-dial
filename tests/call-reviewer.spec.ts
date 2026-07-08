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

// Deterministic golden check: a known transcript with a booking-recovery pattern.
// In mock mode we assert the pipeline SHAPE; the LLM-dependent assertion is
// guarded behind OPENAI_API_KEY so CI without a key still passes.
const GOLDEN = {
  transcript:
    "Agent: I can book you for 4pm Tuesday.\nLead: sure.\nAgent: Hmm, that time isn't available.\nAgent: Actually, you're all set for 4pm Tuesday.",
  expectFlag: "booking_failed_then_recovered",
};

test("golden: booking-failed-then-recovered (live only)", async () => {
  test.skip(!process.env.OPENAI_API_KEY, "needs a live OpenAI key");
  const { analyzeCall } = await import("../src/lib/review/analyze");
  const { flags } = await analyzeCall({
    transcript: GOLDEN.transcript,
    extracted: "{}",
    defs: [
      {
        key: "booking_failed_then_recovered",
        label: "Booking failed then recovered",
        lens: "bug",
        severity: 1,
        guidance:
          "Said a time was unavailable, then booked the same slot anyway.",
      },
    ],
  });
  expect(flags.map((f) => f.flag_key)).toContain(GOLDEN.expectFlag);
});
