// tests/agent-preview.unit.test.ts
import { describe, expect, it } from "vitest";

import { previewScript } from "@/lib/agents/preview";
import { getTemplate } from "@/lib/agents/templates";

const webinar = getTemplate("webinar")!;

describe("previewScript", () => {
  const p = previewScript(webinar.script);

  it("fills sample values into the opening (no raw placeholders)", () => {
    expect(p.opening).toContain("Jamie");
    expect(p.opening).not.toContain("[name]");
    expect(p.opening).not.toContain("[industry]");
    expect(p.opening.length).toBeGreaterThan(0);
  });

  it("lists the specifics, including the recurring schedule (no fixed date)", () => {
    const schedule = p.specifics.find((s) => s.label === "Event schedule");
    expect(schedule?.value).toContain("Every weekday");
    expect(p.specifics.find((s) => s.label === "Event date")).toBeUndefined();
  });

  it("handles an empty script without throwing", () => {
    const blank = getTemplate("blank")!;
    const r = previewScript(blank.script);
    expect(r.opening).toBe("");
    expect(r.specifics).toEqual([]);
  });
});
