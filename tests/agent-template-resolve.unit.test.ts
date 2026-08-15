// tests/agent-template-resolve.unit.test.ts
import { describe, expect, it, vi } from "vitest";

import { resolveTemplate } from "@/lib/agents/templates/resolve";

// Minimal Supabase stub: .from().select().eq().maybeSingle()
function stubSupabase(row: unknown) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: row });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  return { client: { from } as never, from, select, eq, maybeSingle };
}

describe("resolveTemplate", () => {
  it("resolves a code-seed key WITHOUT touching the DB", async () => {
    const s = stubSupabase(null);
    const t = await resolveTemplate("webinar", s.client);
    expect(t?.name).toBe("Webinar invite");
    expect(s.from).not.toHaveBeenCalled();
  });

  it("resolves a DB template by id", async () => {
    const s = stubSupabase({
      id: "abc-123",
      name: "Reactivation",
      description: "d",
      instructions: "# behave",
      default_voice_id: "v1",
      tools: {},
      script: {
        purpose: "P",
        goal: "G",
        scriptProse: "S",
        keyDetails: [],
        dataCollection: [],
      },
    });
    const t = await resolveTemplate("abc-123", s.client);
    expect(t?.name).toBe("Reactivation");
    expect(s.from).toHaveBeenCalledWith("agent_templates");
  });

  it("returns null for an unknown id", async () => {
    const s = stubSupabase(null);
    expect(await resolveTemplate("nope-id", s.client)).toBeNull();
  });
});
