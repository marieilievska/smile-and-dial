import { test, expect } from "vitest";
import {
  applyPromptEdits,
  draftPromptSuggestion,
} from "../src/lib/review/suggest";
import type { PromptEdit } from "../src/lib/review/types";

const PROMPT = [
  "You are Sam, a friendly caller.",
  "Always greet the person by name.",
  "Never mention pricing unless asked.",
].join("\n");

test("replace swaps exactly the anchored passage and nothing else", () => {
  const edits: PromptEdit[] = [
    {
      type: "replace",
      anchor: "Always greet the person by name.",
      text: "Always greet the person by name and wait for their reply.",
    },
  ];
  const r = applyPromptEdits(PROMPT, edits);
  expect(r.error).toBeNull();
  expect(r.result).toBe(
    [
      "You are Sam, a friendly caller.",
      "Always greet the person by name and wait for their reply.",
      "Never mention pricing unless asked.",
    ].join("\n"),
  );
});

test("insert_after adds a new line right after the anchor", () => {
  const r = applyPromptEdits(PROMPT, [
    {
      type: "insert_after",
      anchor: "You are Sam, a friendly caller.",
      text: "Speak slowly and clearly.",
    },
  ]);
  expect(r.error).toBeNull();
  expect(r.result).toContain(
    "You are Sam, a friendly caller.\nSpeak slowly and clearly.\nAlways greet",
  );
});

test("append adds text at the end, separated by a blank line", () => {
  const r = applyPromptEdits(PROMPT, [
    { type: "append", anchor: "", text: "NEW RULE: never talk over the lead." },
  ]);
  expect(r.error).toBeNull();
  expect(r.result).toBe(`${PROMPT}\n\nNEW RULE: never talk over the lead.`);
});

test("multiple edits apply in order against the working text", () => {
  const r = applyPromptEdits(PROMPT, [
    {
      type: "replace",
      anchor: "friendly caller",
      text: "warm, patient caller",
    },
    { type: "append", anchor: "", text: "Always confirm the callback time." },
  ]);
  expect(r.error).toBeNull();
  expect(r.result).toContain("warm, patient caller");
  expect(r.result?.endsWith("Always confirm the callback time.")).toBe(true);
});

test("a later edit's anchor is validated against the working text", () => {
  const r = applyPromptEdits(PROMPT, [
    {
      type: "replace",
      anchor: "friendly caller",
      text: "warm, patient caller",
    },
    {
      type: "replace",
      anchor: "warm, patient caller",
      text: "warm, patient rep",
    },
  ]);
  expect(r.error).toBeNull();
  expect(r.result).toContain("You are Sam, a warm, patient rep.");
});

test("an anchor that is not found is rejected", () => {
  const r = applyPromptEdits(PROMPT, [
    { type: "replace", anchor: "This text is not in the prompt", text: "x" },
  ]);
  expect(r.result).toBeNull();
  expect(r.error).toContain("not found");
});

test("an ambiguous anchor (appears twice) is rejected", () => {
  const twice = "Say hi.\nSay hi.";
  const r = applyPromptEdits(twice, [
    { type: "replace", anchor: "Say hi.", text: "Say hello." },
  ]);
  expect(r.result).toBeNull();
  expect(r.error).toContain("more than once");
});

test("empty replacement text is rejected (no silent deletions)", () => {
  const r = applyPromptEdits(PROMPT, [
    {
      type: "replace",
      anchor: "Never mention pricing unless asked.",
      text: "  ",
    },
  ]);
  expect(r.result).toBeNull();
  expect(r.error).toContain("empty");
});

test("a replace/insert edit with an empty anchor is rejected", () => {
  const r = applyPromptEdits(PROMPT, [
    { type: "replace", anchor: "", text: "x" },
  ]);
  expect(r.result).toBeNull();
  expect(r.error).toContain("anchor");
});

test("zero edits and too many edits are rejected", () => {
  expect(applyPromptEdits(PROMPT, []).error).toContain("No edits");
  const five: PromptEdit[] = Array.from({ length: 5 }, () => ({
    type: "append" as const,
    anchor: "",
    text: "x",
  }));
  expect(applyPromptEdits(PROMPT, five).error).toContain("No more than 4");
});

test("an unknown edit type is rejected", () => {
  const bad = [
    { type: "delete", anchor: "Say hi.", text: "x" },
  ] as unknown as PromptEdit[];
  const r = applyPromptEdits("Say hi.\nBye.", bad);
  expect(r.result).toBeNull();
  expect(r.error).toContain("Unknown edit type");
});

test("an anchor covering the whole prompt is rejected (no full rewrites)", () => {
  const r = applyPromptEdits(PROMPT, [
    { type: "replace", anchor: PROMPT, text: "Entirely new prompt." },
  ]);
  expect(r.result).toBeNull();
  expect(r.error).toContain("whole prompt");
});

test("a full rewrite via a 2-edit chain is rejected", () => {
  const r = applyPromptEdits("A. B. C.", [
    { type: "insert_after", anchor: "A.", text: "X." },
    {
      type: "replace",
      anchor: "A.\nX. B. C.",
      text: "Completely different content.",
    },
  ]);
  expect(r.result).toBeNull();
  expect(r.error).toContain("whole prompt");
});

test("a verbatim CRLF anchor matches; an LF-normalized one does not", () => {
  const crlf = "Line one.\r\nLine two.\r\nLine three.";
  const ok = applyPromptEdits(crlf, [
    { type: "replace", anchor: "Line one.\r\nLine two.", text: "Line 1+2." },
  ]);
  expect(ok.error).toBeNull();
  expect(ok.result).toBe("Line 1+2.\r\nLine three.");
  const bad = applyPromptEdits(crlf, [
    { type: "replace", anchor: "Line one.\nLine two.", text: "x" },
  ]);
  expect(bad.result).toBeNull();
  expect(bad.error).toContain("not found");
});

// Mock-path shape test (callOpenAiJson returns its mock when no OPENAI_API_KEY).
// Guarded like the golden test in call-reviewer.unit.test.ts so a shell with a
// real key doesn't spend money on a unit run.
test("draftPromptSuggestion returns a validated draft in mock mode", async () => {
  if (process.env.OPENAI_API_KEY) return;
  const r = await draftPromptSuggestion({
    prompt: "You are Sam.\nAlways be polite.",
    bucket: {
      key: "talked_over",
      label: "Talked over the lead",
      guidance: "Agent interrupts.",
    },
    examples: [{ evidenceQuote: "Agent: —sorry, go ahead" }],
  });
  expect(r.error).toBeNull();
  expect(r.draft).not.toBeNull();
  expect(r.draft!.edits.length).toBeGreaterThan(0);
  // The mock is an append, so the proposed prompt keeps the original intact.
  expect(r.draft!.proposedPrompt.startsWith("You are Sam.")).toBe(true);
  expect(r.draft!.proposedPrompt.length).toBeGreaterThan(
    "You are Sam.\nAlways be polite.".length,
  );
});
