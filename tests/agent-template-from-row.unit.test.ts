// tests/agent-template-from-row.unit.test.ts
import { describe, expect, it } from "vitest";

import {
  templateFromRow,
  scriptFromJson,
} from "@/lib/agents/templates/from-row";

describe("scriptFromJson", () => {
  it("tolerates junk and returns an empty script", () => {
    expect(scriptFromJson(null)).toEqual({
      purpose: "",
      goal: "",
      keyDetails: [],
      scriptProse: "",
      dataCollection: [],
    });
  });

  it("reads a well-formed script and normalizes key details", () => {
    const s = scriptFromJson({
      purpose: "P",
      goal: "G",
      scriptProse: "S",
      keyDetails: [
        {
          label: "Event date",
          type: "date",
          value: "2026-09-24",
          required: true,
        },
      ],
      dataCollection: [],
    });
    expect(s.purpose).toBe("P");
    expect(s.keyDetails[0]).toEqual({
      id: "event_date",
      label: "Event date",
      type: "date",
      value: "2026-09-24",
      required: true,
    });
  });
});

describe("templateFromRow", () => {
  it("maps a row to the AgentTemplate shape, using the id as the key", () => {
    const t = templateFromRow({
      id: "abc-123",
      name: "Reactivation",
      description: "Win back lapsed customers",
      instructions: "# behave",
      default_voice_id: "v1",
      tools: { schedule_callback: true },
      script: {
        purpose: "P",
        goal: "G",
        scriptProse: "S",
        keyDetails: [],
        dataCollection: [],
      },
    });
    expect(t.key).toBe("abc-123");
    expect(t.name).toBe("Reactivation");
    expect(t.instructions).toBe("# behave");
    expect(t.defaultVoiceId).toBe("v1");
    expect(t.tools).toEqual({ schedule_callback: true });
    expect(t.script.purpose).toBe("P");
  });
});
