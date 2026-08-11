import { describe, expect, test } from "vitest";

import {
  computeCauseOfDeath,
  type LeadForCause,
} from "@/lib/agent-analytics/cause-of-death";

function lead(p: Partial<LeadForCause> & { leadId: string }): LeadForCause {
  return {
    status: "resting",
    decisionMakerReached: false,
    goalMet: false,
    outcomes: [],
    ...p,
  };
}

describe("computeCauseOfDeath — cause assignment (furthest stage wins)", () => {
  test("won: goal_met flag or status", () => {
    const r = computeCauseOfDeath([
      lead({ leadId: "a", goalMet: true, outcomes: ["voicemail", "goal_met"] }),
      lead({ leadId: "b", status: "goal_met" }),
    ]);
    expect(r.counts.won).toBe(2);
    expect(r.groups.won).toBe(2);
  });

  test("won: transferred to a human closer", () => {
    const r = computeCauseOfDeath([
      lead({ leadId: "a", outcomes: ["transferred_to_human"] }),
    ]);
    expect(r.counts.won).toBe(1);
  });

  test("opted out beats everything except won", () => {
    const r = computeCauseOfDeath([
      lead({ leadId: "a", status: "dnc", outcomes: ["not_interested", "dnc"] }),
    ]);
    expect(r.counts.opted_out).toBe(1);
  });

  test("DM said no: a voicemail-then-not_interested lead dies at 'DM said no', not voicemail", () => {
    const r = computeCauseOfDeath([
      lead({
        leadId: "a",
        status: "resting",
        outcomes: ["voicemail", "voicemail", "not_interested"],
      }),
    ]);
    expect(r.counts.dm_said_no).toBe(1);
    expect(r.groups.final).toBe(1);
  });

  test("callback booked and mid-follow-up are 'still in play'", () => {
    const r = computeCauseOfDeath([
      lead({ leadId: "a", status: "callback", outcomes: ["gatekeeper"] }),
      lead({ leadId: "b", status: "ready_to_call", outcomes: ["voicemail"] }),
    ]);
    expect(r.counts.callback_booked).toBe(1);
    expect(r.counts.mid_follow_up).toBe(1);
    expect(r.groups.in_play).toBe(2);
    expect(r.groups.final).toBe(0);
  });

  test("gatekeeper (finished, never reached DM) is a final loss", () => {
    const r = computeCauseOfDeath([
      lead({
        leadId: "a",
        status: "resting",
        decisionMakerReached: false,
        outcomes: ["gatekeeper", "voicemail"],
      }),
    ]);
    expect(r.counts.gatekeeper).toBe(1);
    expect(r.groups.final).toBe(1);
  });

  test("bad number, other (language/ai), never reached", () => {
    const r = computeCauseOfDeath([
      lead({ leadId: "a", status: "resting", outcomes: ["invalid_number"] }),
      lead({ leadId: "b", status: "resting", outcomes: ["language_barrier"] }),
      lead({ leadId: "c", status: "resting", outcomes: ["ai_error"] }),
      lead({
        leadId: "d",
        status: "resting",
        outcomes: ["voicemail", "no_answer", "busy"],
      }),
    ]);
    expect(r.counts.bad_number).toBe(1);
    expect(r.counts.other).toBe(2); // language_barrier + ai_error
    expect(r.counts.never_reached).toBe(1);
  });

  test("totals, groups, and perLead are consistent and deduped", () => {
    const r = computeCauseOfDeath([
      lead({ leadId: "a", goalMet: true }),
      lead({ leadId: "b", outcomes: ["not_interested"] }),
      lead({ leadId: "c", status: "ready_to_call" }),
    ]);
    expect(r.total).toBe(3);
    expect(r.perLead).toHaveLength(3);
    expect(r.groups.won + r.groups.final + r.groups.in_play).toBe(3);
    expect(r.perLead.find((l) => l.leadId === "b")?.cause).toBe("dm_said_no");
  });
});
