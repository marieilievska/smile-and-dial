import { test, expect, describe, it } from "vitest";
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

test.skipIf(!process.env.OPENAI_API_KEY)(
  "golden: booking-failed-then-recovered (live only)",
  async () => {
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
  },
);

import { orderBuckets } from "@/lib/review/buckets";
import type { ReviewFlagDef } from "@/lib/review/types";

describe("orderBuckets", () => {
  const defs: Pick<ReviewFlagDef, "key" | "label" | "lens" | "severity">[] = [
    {
      key: "tool_error",
      label: "Tool error mid-call",
      lens: "bug",
      severity: 1,
    },
    {
      key: "rambled_unclear",
      label: "Rambled / unclear",
      lens: "quality",
      severity: 3,
    },
    {
      key: "price_objection",
      label: "Price objection",
      lens: "voc",
      severity: 4,
    },
  ];

  it("keeps only flags with a matching active def and attaches def metadata", () => {
    const rows = [
      {
        flag_key: "price_objection",
        confirmed_count: 2,
        needs_review_count: 0,
        unreviewed_count: 1,
      },
      {
        flag_key: "retired_flag",
        confirmed_count: 9,
        needs_review_count: 0,
        unreviewed_count: 9,
      },
    ];
    const out = orderBuckets(rows, defs);
    expect(out.map((b) => b.key)).toEqual(["price_objection"]);
    expect(out[0].label).toBe("Price objection");
    expect(out[0].lens).toBe("voc");
    expect(out[0].total).toBe(2);
  });

  it("orders by severity (1 first), then by total desc within a severity", () => {
    const rows = [
      {
        flag_key: "rambled_unclear",
        confirmed_count: 5,
        needs_review_count: 0,
        unreviewed_count: 5,
      },
      {
        flag_key: "tool_error",
        confirmed_count: 1,
        needs_review_count: 0,
        unreviewed_count: 1,
      },
      {
        flag_key: "price_objection",
        confirmed_count: 50,
        needs_review_count: 0,
        unreviewed_count: 3,
      },
    ];
    const out = orderBuckets(rows, defs);
    expect(out.map((b) => b.key)).toEqual([
      "tool_error",
      "rambled_unclear",
      "price_objection",
    ]);
  });

  it("drops buckets whose confirmed+needs_review total is zero", () => {
    const rows = [
      {
        flag_key: "tool_error",
        confirmed_count: 0,
        needs_review_count: 0,
        unreviewed_count: 0,
      },
    ];
    expect(orderBuckets(rows, defs)).toEqual([]);
  });

  it("total counts confirmed + needs_review (both are real flags on the call)", () => {
    const rows = [
      {
        flag_key: "tool_error",
        confirmed_count: 3,
        needs_review_count: 2,
        unreviewed_count: 4,
      },
    ];
    const out = orderBuckets(rows, defs);
    expect(out[0].total).toBe(5);
    expect(out[0].needsReview).toBe(2);
    expect(out[0].unreviewed).toBe(4);
  });
});

import {
  buildDiscoveryPrompt,
  dedupeProposals,
  type DiscoverySample,
  type ProposedCandidate,
} from "@/lib/review/discovery";

describe("buildDiscoveryPrompt", () => {
  const samples: DiscoverySample[] = [
    {
      callId: "c1",
      summary: "Caller asked if we integrate with Mindbody. Agent didn't know.",
    },
    {
      callId: "c2",
      summary: "Caller wanted Spanish; agent only spoke English.",
    },
  ];
  it("lists existing + candidate keys as off-limits and includes the samples", () => {
    const p = buildDiscoveryPrompt({
      samples,
      activeKeys: ["tool_error", "price_objection"],
      candidateKeys: ["mentions_franchise"],
      dismissedLabels: ["Weather smalltalk"],
    });
    expect(p).toContain("tool_error");
    expect(p).toContain("price_objection");
    expect(p).toContain("mentions_franchise");
    expect(p).toContain("Weather smalltalk");
    expect(p).toContain("c1");
    expect(p).toContain("Mindbody");
  });
  it("still builds with empty existing/candidate/dismissed lists", () => {
    const p = buildDiscoveryPrompt({
      samples,
      activeKeys: [],
      candidateKeys: [],
      dismissedLabels: [],
    });
    expect(p).toContain("c2");
  });
});

describe("dedupeProposals", () => {
  const existing = new Set([
    "tool_error",
    "price_objection",
    "mentions_franchise",
  ]);
  const dismissed = new Set(["weather_smalltalk"]);
  const base: ProposedCandidate = {
    key: "x",
    label: "X",
    lens: "voc",
    severity: 4,
    guidance: "g",
    rationale: "r",
    exampleCallIds: ["c1"],
  };
  it("drops proposals whose key already exists (active or candidate) or was dismissed", () => {
    const out = dedupeProposals(
      [
        { ...base, key: "tool_error" },
        { ...base, key: "weather_smalltalk" },
        { ...base, key: "software_integration_gap" },
      ],
      existing,
      dismissed,
    );
    expect(out.map((p) => p.key)).toEqual(["software_integration_gap"]);
  });
  it("drops proposals with an invalid lens or out-of-range severity", () => {
    const out = dedupeProposals(
      [
        { ...base, key: "a", lens: "nonsense" as ProposedCandidate["lens"] },
        { ...base, key: "b", severity: 9 },
        { ...base, key: "c" },
      ],
      existing,
      dismissed,
    );
    expect(out.map((p) => p.key)).toEqual(["c"]);
  });
  it("de-dupes repeated keys within one batch", () => {
    const out = dedupeProposals(
      [
        { ...base, key: "dup" },
        { ...base, key: "dup" },
      ],
      existing,
      dismissed,
    );
    expect(out).toHaveLength(1);
  });
  it("drops proposals with a blank label or guidance", () => {
    const out = dedupeProposals(
      [
        { ...base, key: "no_label", label: "  " },
        { ...base, key: "no_guidance", guidance: "" },
        { ...base, key: "ok" },
      ],
      existing,
      dismissed,
    );
    expect(out.map((p) => p.key)).toEqual(["ok"]);
  });
});
