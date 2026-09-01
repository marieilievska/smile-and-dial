// tests/agent-validate.unit.test.ts
import { describe, expect, it } from "vitest";

import { validateScript } from "@/lib/agents/validate";
import { getTemplate } from "@/lib/agents/templates";

const webinar = getTemplate("webinar")!;

describe("validateScript", () => {
  it("passes a fully-filled webinar with a name", () => {
    expect(validateScript("HireAI Sept", webinar.script)).toEqual([]);
  });

  it("flags a missing name", () => {
    const errs = validateScript("   ", webinar.script);
    expect(errs).toContain("Give the agent a name.");
  });

  it("flags a missing purpose and goal", () => {
    const errs = validateScript("X", {
      ...webinar.script,
      purpose: "",
      goal: "",
    });
    expect(errs).toContain("Add a purpose.");
    expect(errs).toContain("Add a goal.");
  });

  it("flags a required key detail left blank, by its label", () => {
    const keyDetails = webinar.script.keyDetails.map((d) =>
      d.id === "event_schedule" ? { ...d, value: "" } : d,
    );
    const errs = validateScript("X", { ...webinar.script, keyDetails });
    expect(errs).toContain('Fill in "Event schedule".');
  });
});
