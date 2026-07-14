import { describe, expect, it } from "vitest";

import { DYNAMIC_VARIABLE_PLACEHOLDERS } from "../src/lib/elevenlabs/conversation-init";
import {
  ALL_TOOLS,
  assemblePrompt,
  type ToolsEnabled,
} from "../src/lib/agents/prompt";

/**
 * Guards the dynamic-variable contract that lets an agent reference {{var}} on a
 * call. Two invariants that drifted apart once (and this locks back down):
 *
 *  1. The placeholder set an agent declares (DYNAMIC_VARIABLE_PLACEHOLDERS,
 *     pushed to every agent by the sync) must match every variable the
 *     conversation-init webhook actually sends per call. A variable that's sent
 *     but not declared has no default; one that's declared but not sent is dead.
 *
 *  2. The wizard-built prompt may only reference variables that are in that set,
 *     so no {{var}} is ever left permanently blank — the bug that hid in the old
 *     {{lead_context}} placeholder, which nothing ever filled.
 */

// The variables the conversation-init webhook returns per call, restated
// independently of the source so a variable silently added to / dropped from
// the shipped set trips this test.
const EXPECTED_VARIABLES = [
  "booking_crm_software",
  "business_name",
  "call_id",
  "call_type",
  "category",
  "city",
  "current_date",
  "employee_name",
  "google_rating",
  "google_reviews",
  "last_call_summary",
  "last_callback_notes",
  "last_contact",
  "lead_timezone",
  "manager_name",
  "owner_name",
  "transfer_number",
];

describe("dynamic-variable placeholders", () => {
  it("declares exactly the variables the webhook sends", () => {
    expect(Object.keys(DYNAMIC_VARIABLE_PLACEHOLDERS).sort()).toEqual(
      [...EXPECTED_VARIABLES].sort(),
    );
  });

  it("declares every placeholder as a blank-string default", () => {
    for (const value of Object.values(DYNAMIC_VARIABLE_PLACEHOLDERS)) {
      expect(value).toBe("");
    }
  });
});

describe("assemblePrompt lead-context block", () => {
  const allToolsOn: ToolsEnabled = {};
  for (const tool of ALL_TOOLS) allToolsOn[tool] = true;

  const prompt = assemblePrompt({
    personality: "Friendly",
    environment: "Outbound call",
    tone: "Warm",
    goal: "Book a demo",
    guardrails: "Be honest",
    toolsEnabled: allToolsOn,
  });

  it("no longer references the removed {{lead_context}} variable", () => {
    expect(prompt).not.toContain("lead_context");
  });

  it("references the real per-call summary variables instead", () => {
    expect(prompt).toContain("{{last_call_summary}}");
    expect(prompt).toContain("{{last_callback_notes}}");
  });

  it("only references variables that are actually synced to the agent", () => {
    const referenced = [
      ...prompt.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g),
    ].map((m) => m[1]);
    // Guard against a regex/formatting break silently passing the checks above.
    expect(referenced.length).toBeGreaterThan(0);
    for (const name of referenced) {
      expect(DYNAMIC_VARIABLE_PLACEHOLDERS).toHaveProperty(name);
    }
  });
});
