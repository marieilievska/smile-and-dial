import { describe, it, expect } from "vitest";
import { normalizeSteps, type PlaybookStep } from "../src/lib/review/playbook";
import {
  buildPass1User,
  buildPass2User,
  buildPlaybookBlock,
  buildRejectedBlock,
  PLAYBOOK_MISSED_KEY,
} from "../src/lib/review/prompts";
import type { ReviewFlagDef } from "../src/lib/review/types";

const step = (over: Partial<PlaybookStep> = {}): PlaybookStep => ({
  key: "anchor_question",
  title: "Ask the lead-response-speed question",
  rigid: false,
  requirement: "Asks how fast the business responds to new inquiries.",
  applies_when: "once the owner is on the line",
  ...over,
});

describe("normalizeSteps", () => {
  it("slugifies keys, defaults applies_when, and coerces rigid to a boolean", () => {
    const out = normalizeSteps([
      {
        key: "Intro States AI!",
        title: "Intro",
        rigid: "yes",
        requirement: "Says he is an AI.",
        applies_when: "",
      } as unknown as PlaybookStep,
    ]);
    expect(out).toEqual([
      {
        key: "intro_states_ai",
        title: "Intro",
        rigid: false,
        requirement: "Says he is an AI.",
        applies_when: "every call",
      },
    ]);
  });

  it("drops steps with no title or no requirement", () => {
    const out = normalizeSteps([
      step({ title: "   " }),
      step({ key: "b", requirement: "" }),
      step({ key: "c" }),
    ]);
    expect(out.map((s) => s.key)).toEqual(["c"]);
  });

  it("de-duplicates keys rather than losing a step", () => {
    const out = normalizeSteps([step({ key: "dup" }), step({ key: "dup" })]);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((s) => s.key)).size).toBe(2);
  });
});

describe("buildPlaybookBlock", () => {
  it("tells the reviewer that a flexible step's wording is free", () => {
    // This is the whole fix: the agents' prompts require paraphrasing their
    // sample lines, and the old reviewer read paraphrase as going off-script.
    const text = buildPlaybookBlock([step({ rigid: false })]);
    expect(text).toContain("wording is free");
    expect(text).toContain("Different phrasing from the playbook is CORRECT");
  });

  it("marks a rigid step as having to happen its specific way", () => {
    expect(buildPlaybookBlock([step({ rigid: true })])).toContain(
      "MUST happen this specific way",
    );
  });

  it("refuses to fault end-of-call steps on a truncated transcript", () => {
    expect(buildPlaybookBlock([step()])).toContain("ends abruptly");
  });

  it("is empty when the agent has no derived checklist", () => {
    expect(buildPlaybookBlock([])).toBe("");
  });
});

describe("buildRejectedBlock", () => {
  it("feeds past false alarms back so a rejection suppresses the next one", () => {
    const text = buildRejectedBlock([
      {
        flagKey: PLAYBOOK_MISSED_KEY,
        stepKey: "anchor_question",
        evidenceQuote: "Agent: so how fast do you usually get back to folks?",
      },
    ]);
    expect(text).toContain("REJECTED BY A HUMAN");
    expect(text).toContain("anchor_question");
    expect(text).toContain("how fast do you usually get back");
  });

  it("says nothing when there are no usable rejections", () => {
    expect(buildRejectedBlock([])).toBe("");
    expect(
      buildRejectedBlock([
        { flagKey: "monologued", stepKey: null, evidenceQuote: "  " },
      ]),
    ).toBe("");
  });
});

describe("pass prompts", () => {
  const defs: ReviewFlagDef[] = [
    {
      key: "monologued",
      label: "Monologued",
      lens: "quality",
      severity: 3,
      guidance: "Stacked several points into one turn.",
    },
  ];

  it("pass 1 permits a clean call to come back empty", () => {
    const user = buildPass1User({
      steps: [step()],
      defs,
      extracted: "{}",
      transcript: "Agent: hi\nLead: hi",
      rejected: [],
    });
    expect(user).toContain("Return an empty list if the call was fine");
    expect(user).toContain("anchor_question");
    expect(user).toContain("monologued");
  });

  it("pass 2 tells the verifier to reject a flexible step done in other words", () => {
    const user = buildPass2User({
      meaning: "Skipped a required step.",
      evidenceQuote: "q",
      transcript: "t",
      step: step({ rigid: false }),
    });
    expect(user).toContain("wording of this step is FREE");
    expect(user).toContain("answer agree=false");
  });

  it("pass 2 keeps a rigid step strict", () => {
    const user = buildPass2User({
      meaning: "Skipped a required step.",
      evidenceQuote: "q",
      transcript: "t",
      step: step({ rigid: true }),
    });
    expect(user).toContain("MUST happen its specific way");
  });
});
