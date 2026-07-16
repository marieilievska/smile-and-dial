import { test, expect } from "vitest";
import { applyPromptEdits } from "../src/lib/review/suggest";
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
  expect(applyPromptEdits(PROMPT, five).error).toContain("more than");
});
