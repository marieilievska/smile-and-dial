import { describe, expect, it } from "vitest";

import { countLeadCalls } from "@/lib/leads/call-counters";

/** `leads.call_attempts` / `leads.conversations` are derived from the lead's
 *  calls rows by ONE function. Attempts = every row (inbound, failed, all);
 *  conversations = the CONVERSATION_OUTCOMES subset. */
describe("countLeadCalls", () => {
  it("counts every call row as an attempt, whatever its outcome", () => {
    const c = countLeadCalls([
      { outcome: "voicemail" },
      { outcome: "failed" },
      { outcome: null },
      { outcome: "hung_up_immediately" },
    ]);
    expect(c).toEqual({ call_attempts: 4, conversations: 0 });
  });

  it("counts only real two-way conversations as conversations", () => {
    const c = countLeadCalls([
      { outcome: "voicemail" },
      { outcome: "gatekeeper" },
      { outcome: "callback" },
      { outcome: "goal_met" },
      { outcome: "ai_receptionist" },
      { outcome: "hung_up_later" },
      { outcome: "not_interested" },
      { outcome: "gatekeeper_not_interested" },
    ]);
    expect(c).toEqual({ call_attempts: 8, conversations: 5 });
  });

  it("is zero for a lead with no calls", () => {
    expect(countLeadCalls([])).toEqual({ call_attempts: 0, conversations: 0 });
  });
});
