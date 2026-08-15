// tests/agent-assemble.unit.test.ts
import { describe, expect, it } from "vitest";

import { assembleFromScript } from "@/lib/agents/assemble";
import { getTemplate } from "@/lib/agents/templates";

const webinar = getTemplate("webinar")!;

describe("assembleFromScript", () => {
  const prompt = assembleFromScript({
    instructions: webinar.instructions,
    script: webinar.script,
    toolsEnabled: webinar.tools,
  });

  it("keeps the locked behavior at the top", () => {
    expect(prompt).toContain("exactly ONE question");
  });

  it("renders purpose, goal, and the specifics block", () => {
    expect(prompt).toContain("# Your job");
    expect(prompt).toContain("# Your goal");
    expect(prompt).toContain("# The specifics");
    expect(prompt).toContain("Event name: Answer Every Call, Book Every Lead");
  });

  it("injects the date once, formatted, and never as a raw literal in the prose", () => {
    const occurrences = prompt.split("August 27, 2026").length - 1;
    expect(occurrences).toBe(1);
    expect(prompt).not.toContain("2026-08-27"); // ISO value is formatted away
  });

  it("appends enabled tool blocks and the shared lead-context + error blocks", () => {
    expect(prompt).toContain("## smiledial_schedule_callback");
    expect(prompt).toContain("{{last_call_summary}}");
    expect(prompt).toContain("# Tool error handling");
  });

  it("omits empty sections without throwing", () => {
    const blank = getTemplate("blank")!;
    const p = assembleFromScript({
      instructions: blank.instructions,
      script: blank.script,
      toolsEnabled: blank.tools,
    });
    expect(p).not.toContain("# The specifics");
    expect(p).not.toContain("# Your job");
    expect(p).toContain("exactly ONE question");
  });
});
