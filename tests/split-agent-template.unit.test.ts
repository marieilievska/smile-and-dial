// tests/split-agent-template.unit.test.ts
import { describe, expect, it } from "vitest";

import {
  parseSplitResponse,
  splitAgentIntoTemplate,
} from "@/lib/ai/split-agent-template";
import { SHARED_INSTRUCTIONS } from "@/lib/agents/templates/instructions";

describe("parseSplitResponse", () => {
  it("parses model JSON and normalizes key details (dates typed)", () => {
    const json = JSON.stringify({
      name: "Webinar invite",
      description: "Invite owners to an event",
      instructions: "# behave",
      purpose: "Invite owners",
      goal: "Book a seat",
      keyDetails: [
        {
          label: "Event date",
          type: "date",
          value: "2026-09-24",
          required: true,
        },
      ],
      scriptProse: "Hi [name]…",
    });
    const out = parseSplitResponse(json, "Fallback Name")!;
    expect(out.name).toBe("Webinar invite");
    expect(out.source).toBe("openai");
    expect(out.keyDetails[0]).toMatchObject({
      id: "event_date",
      type: "date",
      required: true,
    });
  });

  it("returns null on unparseable text", () => {
    expect(parseSplitResponse("not json", "X")).toBeNull();
  });

  it("falls back to the agent name when the model omits a name", () => {
    const out = parseSplitResponse(
      JSON.stringify({ scriptProse: "hi" }),
      "My Agent",
    )!;
    expect(out.name).toBe("My Agent");
    expect(out.instructions).toBe(SHARED_INSTRUCTIONS); // default when omitted
  });
});

describe("splitAgentIntoTemplate fallback", () => {
  it("drops raw prompt into the script when there's no source text", async () => {
    const out = await splitAgentIntoTemplate("", "My Agent");
    expect(out).toEqual({
      name: "My Agent",
      description: "",
      instructions: SHARED_INSTRUCTIONS,
      purpose: "",
      goal: "",
      keyDetails: [],
      scriptProse: "",
      source: "fallback",
    });
  });
});
