import { describe, expect, it } from "vitest";

import { describeEvent } from "@/app/(app)/leads/[id]/activity-feed";
import { CALLBACK_PAST_TIME_CLAMPED } from "@/lib/dialer/local-schedule";

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

/**
 * The clamp is an alarm, not routine bookkeeping: it fires only when a callback
 * would otherwise have been written at a time that had already passed, which is
 * what got a Halifax lead called three times in four minutes. Marija reads this
 * feed, so it has to say what happened in words, not "Callback past time
 * clamped".
 */
describe("the lead Activity feed names a clamped callback", () => {
  it("says the agent's time had already passed and what we did instead", () => {
    const line = describeEvent({
      kind: "event",
      id: "event-2",
      at: "2026-09-11T15:00:00.000Z",
      eventKind: CALLBACK_PAST_TIME_CLAMPED,
      payload: {
        model_datetime: "2026-09-11T08:52:00-04:00",
        lead_timezone: "America/Halifax",
      },
    });

    expect(line).toBe(
      "Callback time had already passed — held to the next few minutes instead",
    );
  });
});
