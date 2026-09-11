import { describe, expect, it } from "vitest";

import { describeEvent } from "@/app/(app)/leads/[id]/activity-feed";

/**
 * The lead Activity feed shows each system_events row as one line. A kind with
 * no line of its own falls back to its raw name with the underscores removed,
 * which for the dialer's number skip would read "Lead phone not us ca".
 */
describe("the lead Activity feed names the dialer's number skip", () => {
  it("in plain words, not the raw event kind", () => {
    const line = describeEvent({
      kind: "event",
      id: "event-1",
      at: "2026-09-11T15:00:00.000Z",
      eventKind: "lead_phone_not_us_ca",
      payload: { lead_id: "lead-1", campaign_id: "campaign-1" },
    });

    expect(line).toBe(
      "Not dialed: the number isn't a US or Canadian (+1) number",
    );
  });
});
