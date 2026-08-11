import { describe, expect, test } from "vitest";

import {
  OBJECTION_CATEGORIES,
  buildObjectionPrompt,
  parseObjectionResponse,
  transcriptToText,
} from "@/lib/openai/objection-extractor";

describe("transcriptToText", () => {
  test("labels agent vs lead turns in time order", () => {
    const text = transcriptToText([
      { role: "agent", message: "Hi, is the owner in?", time_in_call_secs: 1 },
      { role: "user", message: "We already use Podium.", time_in_call_secs: 4 },
    ]);
    expect(text).toBe(
      "Agent: Hi, is the owner in?\nLead: We already use Podium.",
    );
  });

  test("handles empty / malformed transcript", () => {
    expect(transcriptToText(null)).toBe("");
    expect(transcriptToText([])).toBe("");
  });
});

describe("buildObjectionPrompt", () => {
  test("includes the transcript and the allowed categories", () => {
    const p = buildObjectionPrompt("Agent: hi\nLead: too expensive");
    expect(p).toContain("too expensive");
    for (const c of OBJECTION_CATEGORIES) expect(p).toContain(c);
  });
});

describe("parseObjectionResponse", () => {
  test("accepts a valid category + specific + quote", () => {
    const r = parseObjectionResponse(
      JSON.stringify({
        objection_present: true,
        category: "already_have_solution",
        specific: "already using Podium",
        quote: "We already use Podium for that.",
      }),
    );
    expect(r).toEqual({
      category: "already_have_solution",
      specific: "already using Podium",
      quote: "We already use Podium for that.",
    });
  });

  test("no objection → null", () => {
    expect(
      parseObjectionResponse(JSON.stringify({ objection_present: false })),
    ).toBeNull();
  });

  test("unknown category is coerced to 'other'", () => {
    const r = parseObjectionResponse(
      JSON.stringify({
        objection_present: true,
        category: "banana",
        specific: "x",
        quote: "y",
      }),
    );
    expect(r?.category).toBe("other");
  });

  test("garbage / non-JSON → null", () => {
    expect(parseObjectionResponse("not json")).toBeNull();
    expect(parseObjectionResponse("")).toBeNull();
  });
});
