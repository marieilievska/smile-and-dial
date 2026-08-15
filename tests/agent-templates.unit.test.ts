// tests/agent-templates.unit.test.ts
import { describe, expect, it } from "vitest";

import { normalizeKeyDetails } from "@/lib/agents/templates/types";

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
