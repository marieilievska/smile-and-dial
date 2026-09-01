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

  it("injects the schedule once (from the key-detail) and carries no fixed date", () => {
    // The event recurs; the schedule lives ONLY in the key-detail so it can't
    // go stale in two places, and the prose reads real sessions from the tool.
    const occurrences =
      prompt.split("Every weekday (Monday to Friday) at 2 PM Eastern").length -
      1;
    expect(occurrences).toBe(1);
    expect(prompt).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    expect(prompt).not.toContain("August 27");
    expect(prompt).toContain("smiledial_get_available_times");
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
