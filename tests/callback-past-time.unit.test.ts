import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALLBACK_FLOOR_MS,
  resolveCallbackDatetime,
} from "@/lib/dialer/local-schedule";
import { applyOutcomeSideEffects } from "@/lib/elevenlabs/post-call-webhook";
import { makeFakeDb } from "./helpers/fake-supabase";

/**
 * A callback must never be written at a time that has already passed.
 *
 * On 2026-09-11 "Divine Warrior Ninjutsu" (America/Halifax) was called three
 * times in four minutes — 08:36, 08:38 and 08:40 ET — and asked to be removed:
 * "It has not been 20 minutes. You just called me three times in a row." The
 * lead is now on the DNC list. Each of those calls ended with the gatekeeper
 * saying "try again in about 20 minutes", and each wrote a callback ~40 minutes
 * in the PAST, which the dialer redeems immediately because callbacks bypass
 * the throughput caps at dial_priority 0.
 *
 * The cause is a frame mismatch, proven from the stored webhook payload:
 *
 *  - ElevenLabs does NOT interpolate `{{current_time}}` / `{{lead_timezone}}`
 *    in data-collection field descriptions. The returned json_schema still
 *    contains the literal mustaches, so the extractor never sees the lead's
 *    local clock — it anchors on ElevenLabs' own `system__timezone`, which is
 *    America/New_York, and `system__time` ("Friday, 08:32 11 September 2026").
 *  - So for "in 20 minutes" it wrote `2026-09-11T08:52:00-04:00`. That is the
 *    RIGHT instant (12:52Z, 19 minutes after the call ended) expressed in the
 *    WRONG zone's wall clock.
 *  - `parseLeadLocalDatetime` then deliberately discards the offset and re-reads
 *    "08:52" as Halifax time → 11:52Z, an hour earlier, i.e. already past.
 *
 * Discarding the offset is right for the case it was written for (a named time:
 * the model writes the clock the person actually said and stamps Eastern on it
 * regardless, so "10:00-04:00" for a Honolulu spa means 10:00 HST). It is wrong
 * for a relative time, where the wall clock itself is Eastern. The two cases are
 * indistinguishable from the string alone — but they are distinguishable by
 * outcome: the extractor never intends to book the past, so when the lead-local
 * reading lands in the past and the stamped offset lands in the future, the
 * stamped offset is the one that was meant.
 */
describe("resolveCallbackDatetime", () => {
  it("recovers a relative callback the extractor timed in Eastern for an Atlantic lead", () => {
    // The exact prod values from call cbe2bb5a (GoodLife Fitness Charlottetown).
    const now = new Date("2026-09-11T12:33:09.575Z");
    expect(
      resolveCallbackDatetime(
        "2026-09-11T08:52:00-04:00",
        "America/Halifax",
        now,
      )?.toISOString(),
      // NOT 11:52Z (40 minutes before this call even ended).
    ).toBe("2026-09-11T12:52:00.000Z");
  });

  it("still reads a named wall-clock time in the lead's zone", () => {
    // "tomorrow morning" for a Honolulu spa: the model writes the clock the
    // person said and stamps Eastern on it. 10:00 HST is 20:00Z, and trusting
    // the -04:00 would give 4 AM their time. Unchanged by the fix: the
    // lead-local reading is already in the future, so it wins outright.
    const now = new Date("2026-09-02T18:00:00Z");
    expect(
      resolveCallbackDatetime(
        "2026-09-03T10:00:00-04:00",
        "Pacific/Honolulu",
        now,
      )?.toISOString(),
    ).toBe("2026-09-03T20:00:00.000Z");
  });

  it("leaves a genuinely past time in the past for the caller to handle", () => {
    // Both readings are behind `now`, so there is nothing to recover: the
    // resolver reports the lead-local reading and the write path clamps it.
    const now = new Date("2026-09-11T20:00:00Z");
    expect(
      resolveCallbackDatetime(
        "2026-09-11T08:52:00-04:00",
        "America/Halifax",
        now,
      )?.toISOString(),
    ).toBe("2026-09-11T11:52:00.000Z");
  });

  it("returns null for blank or unparseable input", () => {
    expect(resolveCallbackDatetime("", "America/Halifax")).toBeNull();
    expect(resolveCallbackDatetime(null, "America/Halifax")).toBeNull();
    expect(resolveCallbackDatetime("whenever", "America/Halifax")).toBeNull();
  });
});

/** Seed the tables `applyOutcomeSideEffects` touches for an outcome=callback. */
function seedDb(leadTimezone: string) {
  return makeFakeDb({
    leads: [
      {
        id: "lead-1",
        business_phone: "+19025550123",
        company: "Divine Warrior Ninjutsu",
        owner_id: "owner-1",
        timezone: leadTimezone,
        calendly_event_uri: null,
        status: "new",
        next_call_at: null,
      },
    ],
    calls: [{ id: "call-1", lead_id: "lead-1", outcome: "callback" }],
    campaigns: [
      { id: "camp-1", calendly_event_id: null, fixed_time_booking: false },
    ],
    callbacks: [],
  });
}

describe("post-call webhook never books a callback in the past", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores the Atlantic lead's callback 20 minutes ahead, not 40 behind", async () => {
    vi.setSystemTime(new Date("2026-09-11T12:33:09.575Z"));
    const db = seedDb("America/Halifax");
    await applyOutcomeSideEffects(db.client as never, {
      callId: "call-1",
      leadId: "lead-1",
      campaignId: "camp-1",
      outcome: "callback",
      callbackDatetime: "2026-09-11T08:52:00-04:00",
    });
    const rows = db.tables.callbacks;
    expect(rows).toHaveLength(1);
    expect(rows[0].scheduled_at).toBe("2026-09-11T12:52:00.000Z");
  });

  it("clamps to a short floor when the time is past in every reading", async () => {
    const now = new Date("2026-09-11T20:00:00.000Z");
    vi.setSystemTime(now);
    const db = seedDb("America/Halifax");
    await applyOutcomeSideEffects(db.client as never, {
      callId: "call-1",
      leadId: "lead-1",
      campaignId: "camp-1",
      outcome: "callback",
      callbackDatetime: "2026-09-11T08:52:00-04:00",
    });
    const rows = db.tables.callbacks;
    expect(rows).toHaveLength(1);
    expect(rows[0].scheduled_at).toBe(
      new Date(now.getTime() + CALLBACK_FLOOR_MS).toISOString(),
    );
  });
});

/**
 * The in-call tool is the other writer. It already refused a past time, so it
 * never produced one of the bad rows — but it refused the Atlantic "in 20
 * minutes" case too, telling a lead who had just named a perfectly good time
 * that it "has already passed". Same frame mismatch, different symptom.
 */
describe("in-call schedule_callback tool", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://stub";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  async function runTool(callbackDatetime: string, timezone: string) {
    const db = makeFakeDb({
      calls: [{ id: "call-1", lead_id: "lead-1", campaign_id: "camp-1" }],
      leads: [{ id: "lead-1", owner_id: "owner-1", timezone, status: "new" }],
      callbacks: [],
    });
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => db.client,
    }));
    const { executeServerTool } = await import("@/lib/elevenlabs/tool-webhook");
    const result = await executeServerTool("schedule_callback", {
      call_id: "call-1",
      callback_datetime: callbackDatetime,
    });
    return { result, db };
  }

  it("books the Atlantic lead's 'in 20 minutes' instead of refusing it", async () => {
    vi.setSystemTime(new Date("2026-09-11T12:33:09.575Z"));
    const { result, db } = await runTool(
      "2026-09-11T08:52:00-04:00",
      "America/Halifax",
    );
    expect(result.success).toBe(true);
    expect(db.tables.callbacks).toHaveLength(1);
    expect(db.tables.callbacks[0].scheduled_at).toBe(
      "2026-09-11T12:52:00.000Z",
    );
  });

  it("still re-asks when the time is genuinely past", async () => {
    vi.setSystemTime(new Date("2026-09-11T20:00:00.000Z"));
    const { result, db } = await runTool(
      "2026-09-11T08:52:00-04:00",
      "America/Halifax",
    );
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/already passed/i);
    expect(db.tables.callbacks).toHaveLength(0);
  });

  it("holds a near-instant callback to the floor", async () => {
    const now = new Date("2026-09-11T12:33:00.000Z");
    vi.setSystemTime(now);
    // 08:34 Eastern — one minute out. Real, but the dialer would ring the
    // number we are still hanging up on.
    const { result, db } = await runTool(
      "2026-09-11T08:34:00-04:00",
      "America/Halifax",
    );
    expect(result.success).toBe(true);
    expect(db.tables.callbacks[0].scheduled_at).toBe(
      new Date(now.getTime() + CALLBACK_FLOOR_MS).toISOString(),
    );
  });
});
