// tests/agent-templates.unit.test.ts
import { describe, expect, it } from "vitest";

import { normalizeKeyDetails } from "@/lib/agents/templates/types";
import { SHARED_INSTRUCTIONS } from "@/lib/agents/templates/instructions";
import { AGENT_TEMPLATES, getTemplate } from "@/lib/agents/templates";

describe("normalizeKeyDetails", () => {
  it("returns [] for non-arrays", () => {
    expect(normalizeKeyDetails(null)).toEqual([]);
    expect(normalizeKeyDetails("nope")).toEqual([]);
  });

  it("derives a snake_case id from the label and defaults type to text", () => {
    const out = normalizeKeyDetails([{ label: "Event Name", value: "X" }]);
    expect(out).toEqual([
      {
        id: "event_name",
        label: "Event Name",
        type: "text",
        value: "X",
        required: false,
      },
    ]);
  });

  it("keeps a valid date type and required flag, and drops entries with no label", () => {
    const out = normalizeKeyDetails([
      {
        label: "Event date",
        type: "date",
        value: "2026-08-27",
        required: true,
      },
      { label: "", value: "orphan" },
    ]);
    expect(out).toEqual([
      {
        id: "event_date",
        label: "Event date",
        type: "date",
        value: "2026-08-27",
        required: true,
      },
    ]);
  });

  it("coerces an unknown type back to text and de-dupes by id", () => {
    const out = normalizeKeyDetails([
      { label: "Note", type: "wat", value: "a" },
      { label: "note", value: "b" }, // same id -> dropped
    ]);
    expect(out).toEqual([
      { id: "note", label: "Note", type: "text", value: "a", required: false },
    ]);
  });
});

describe("SHARED_INSTRUCTIONS", () => {
  it("carries the load-bearing behaviors and no campaign specifics", () => {
    expect(SHARED_INSTRUCTIONS).toContain("exactly ONE question");
    expect(SHARED_INSTRUCTIONS).toContain("smiledial_mark_dnc");
    expect(SHARED_INSTRUCTIONS).toContain("Gatekeepers");
    // Persona-neutral: the seed webinar's specifics must NOT be baked in here.
    expect(SHARED_INSTRUCTIONS).not.toContain("HireAI");
    expect(SHARED_INSTRUCTIONS).not.toContain("Tom");
  });
});

describe("template registry", () => {
  it("exposes webinar and blank", () => {
    expect(AGENT_TEMPLATES.map((t) => t.key).sort()).toEqual([
      "blank",
      "webinar",
    ]);
    expect(getTemplate("webinar")?.name).toBe("Webinar invite");
    expect(getTemplate("nope")).toBeUndefined();
  });

  it("webinar carries a required date key-detail and a filled script", () => {
    const w = getTemplate("webinar")!;
    const date = w.script.keyDetails.find((d) => d.id === "event_date");
    expect(date).toMatchObject({ type: "date", required: true });
    expect(w.script.purpose.length).toBeGreaterThan(0);
    expect(w.script.goal.length).toBeGreaterThan(0);
    expect(w.tools.schedule_callback).toBe(true);
  });

  it("blank shares the instructions but has an empty script", () => {
    const b = getTemplate("blank")!;
    expect(b.instructions).toContain("exactly ONE question");
    expect(b.script.purpose).toBe("");
    expect(b.script.keyDetails).toEqual([]);
  });
});
