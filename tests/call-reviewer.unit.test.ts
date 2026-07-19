import { test, expect, describe, it } from "vitest";
import { defsForAnalysis } from "../src/lib/review/rubric";
import { findingId, mergeVerification } from "../src/lib/review/analyze";
import type { ProposedFinding } from "../src/lib/review/types";

test("defsForAnalysis hides no_conversation from the AI (it's stamped at enqueue)", () => {
  const defs = [
    {
      key: "no_conversation",
      label: "No conversation",
      lens: "voc" as const,
      severity: 4,
      guidance: "Voicemail.",
    },
    {
      key: "monologued",
      label: "Monologued",
      lens: "quality" as const,
      severity: 3,
      guidance: "Stacked beats.",
    },
  ];
  expect(defsForAnalysis(defs).map((d) => d.key)).toEqual(["monologued"]);
});

test("findingId identifies a playbook miss per step, everything else per flag", () => {
  expect(findingId("playbook_missed", "intro_states_ai")).toBe(
    "playbook_missed:intro_states_ai",
  );
  expect(findingId("monologued", null)).toBe("monologued");
});

test("mergeVerification confirms agreed findings and flags disagreements for review", () => {
  const proposed: ProposedFinding[] = [
    {
      flag_key: "wrong_data_used",
      step_key: null,
      evidence_quote: "called them Acme",
      confidence: 0.9,
    },
    {
      flag_key: "monologued",
      step_key: null,
      evidence_quote: "long turn",
      confidence: 0.8,
    },
    {
      flag_key: "talked_over",
      step_key: null,
      evidence_quote: "n/a",
      confidence: 0.4,
    },
  ];
  const verdicts = {
    wrong_data_used: {
      agree: true,
      confidence: 0.95,
      evidence_quote: "called them Acme Ltd",
    },
    monologued: { agree: false, confidence: 0.9, evidence_quote: "" },
    talked_over: { agree: true, confidence: 0.5, evidence_quote: "n/a" },
  };
  const merged = mergeVerification(proposed, verdicts);
  expect(merged.find((f) => f.flag_key === "wrong_data_used")).toMatchObject({
    status: "confirmed",
    evidence_quote: "called them Acme Ltd",
  });
  expect(merged.find((f) => f.flag_key === "monologued")).toBeUndefined();
  expect(merged.find((f) => f.flag_key === "talked_over")).toMatchObject({
    status: "needs_review",
  });
});

test("mergeVerification keeps two missed steps apart under the same flag", () => {
  const proposed: ProposedFinding[] = [
    {
      flag_key: "playbook_missed",
      step_key: "intro_states_ai",
      evidence_quote: "a",
      confidence: 0.9,
    },
    {
      flag_key: "playbook_missed",
      step_key: "hosting_disclosure",
      evidence_quote: "b",
      confidence: 0.9,
    },
  ];
  const merged = mergeVerification(proposed, {
    "playbook_missed:intro_states_ai": {
      agree: true,
      confidence: 0.9,
      evidence_quote: "a",
    },
    "playbook_missed:hosting_disclosure": {
      agree: false,
      confidence: 0.9,
      evidence_quote: "",
    },
  });
  expect(merged.map((f) => f.step_key)).toEqual(["intro_states_ai"]);
});

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
