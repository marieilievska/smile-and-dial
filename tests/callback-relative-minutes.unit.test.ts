import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BASE_DATA_COLLECTION_IDS,
  normalizeDataCollection,
} from "@/lib/agents/data-collection";
import { CALLBACK_FLOOR_MS } from "@/lib/dialer/local-schedule";
import { applyOutcomeSideEffects } from "@/lib/elevenlabs/post-call-webhook";
import { makeFakeDb } from "./helpers/fake-supabase";

/**
 * A callback the lead asked for "in an hour" must land an hour out — not one,
 * two or three hours late because the lead lives west of Eastern.
 *
 * #533 fixed the direction that lands in the PAST (zones AHEAD of Eastern).
 * This is the other direction. Proven in prod on call
 * ae7bb39e-57f8-40cc-92a9-6ecadfe9eb4e (America/Los_Angeles, ended
 * 2026-09-11T16:47:54.833Z): gatekeeper Cameron said "call back in about an
 * hour", the model wrote 2026-09-11T13:47:00-04:00 — 17:47Z, the RIGHT instant
 * in ElevenLabs' own Eastern wall clock — and re-reading "13:47" as Los Angeles
 * stored 20:47Z, three hours late. Measured across prod callbacks since
 * 2026-09-08: America/Chicago +1h, America/Denver +2h, America/Los_Angeles +3h.
 *
 * The past-guard from #533 cannot catch this: both readings are in the future,
 * so there is nothing to disqualify. Nor can the parser choose between them —
 * the lead-local reading is the RIGHT one for a NAMED time ("tomorrow at 10"),
 * which is exactly what parseLeadLocalDatetime exists for, and the string
 * carries no signal saying which kind of request it came from.
 *
 * So we stop asking the model for a wall clock at all when the request was
 * relative. callback_relative_minutes is a plain count of minutes with no
 * timezone anywhere in it — which is also why it survives the defect that
 * started all of this: ElevenLabs does not interpolate {{dynamic_variables}}
 * into data-collection descriptions, and this field needs none.
 */

const CALL_ENDED = "2026-09-11T16:47:54.833Z";
const MODEL_WROTE = "2026-09-11T13:47:00-04:00"; // 17:47Z, Eastern wall clock
const AN_HOUR_LATER = "2026-09-11T17:47:54.833Z";

// The rule TEXT is asserted in callback-relative-minutes-rule.unit.test.ts:
// importing server-tools here would eagerly instantiate the tool-webhook graph
// and deadlock the vi.resetModules() re-import the in-call describe below does.
describe("the relative-minutes field is load-bearing", () => {
  it("is a base data-collection id a custom field can never shadow", () => {
    expect(BASE_DATA_COLLECTION_IDS.has("callback_relative_minutes")).toBe(
      true,
    );
    expect(
      normalizeDataCollection([
        {
          id: "callback_relative_minutes",
          type: "string",
          description: "mine",
        },
      ]),
    ).toEqual([]);
  });
});

/** Seed the tables applyOutcomeSideEffects touches for an outcome=callback. */
function seedDb(timezone: string, endedAt: string | null = CALL_ENDED) {
  return makeFakeDb({
    leads: [
      {
        id: "lead-1",
        business_phone: "+13105550123",
        company: "Anytime Fitness Van Nuys",
        owner_id: "owner-1",
        timezone,
        calendly_event_uri: null,
        status: "new",
        next_call_at: null,
      },
    ],
    calls: [
      {
        id: "call-1",
        lead_id: "lead-1",
        outcome: "callback",
        ended_at: endedAt,
      },
    ],
    campaigns: [
      { id: "camp-1", calendly_event_id: null, fixed_time_booking: false },
    ],
    callbacks: [],
  });
}

async function run(
  db: ReturnType<typeof makeFakeDb>,
  extra: Record<string, unknown>,
) {
  await applyOutcomeSideEffects(
    db.client as never,
    {
      callId: "call-1",
      leadId: "lead-1",
      campaignId: "camp-1",
      outcome: "callback",
      callbackDatetime: null,
      ...extra,
    } as never,
  );
}

describe("post-call webhook honours a relative callback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("books 'in an hour' an hour after the call ended, not 3 hours late", async () => {
    vi.setSystemTime(new Date("2026-09-11T16:48:10.000Z"));
    const db = seedDb("America/Los_Angeles");
    await run(db, {
      callbackDatetime: MODEL_WROTE,
      callbackRelativeMinutes: 60,
    });
    expect(db.tables.callbacks).toHaveLength(1);
    // NOT 2026-09-11T20:47:00.000Z, which is what prod stored.
    expect(db.tables.callbacks[0].scheduled_at).toBe(AN_HOUR_LATER);
  });

  it("counts from now when the call row has no ended_at", async () => {
    const now = new Date("2026-09-11T16:48:10.000Z");
    vi.setSystemTime(now);
    const db = seedDb("America/Los_Angeles", null);
    await run(db, { callbackRelativeMinutes: 30 });
    expect(db.tables.callbacks[0].scheduled_at).toBe(
      new Date(now.getTime() + 30 * 60_000).toISOString(),
    );
  });

  it("still holds a very short delay to the floor", async () => {
    const now = new Date("2026-09-11T16:48:10.000Z");
    vi.setSystemTime(now);
    const db = seedDb("America/Los_Angeles", null);
    await run(db, { callbackRelativeMinutes: 1 });
    expect(db.tables.callbacks[0].scheduled_at).toBe(
      new Date(now.getTime() + CALLBACK_FLOOR_MS).toISOString(),
    );
  });

  it("ignores a missing, zero or nonsense minute count and uses the datetime", async () => {
    vi.setSystemTime(new Date("2026-09-02T18:00:00Z"));
    for (const minutes of [null, 0, -5, Number.NaN, "soon"]) {
      const db = seedDb("Pacific/Honolulu");
      await run(db, {
        callbackDatetime: "2026-09-03T10:00:00-04:00",
        callbackRelativeMinutes: minutes,
      });
      // The Honolulu named-time case #533 pinned: 10:00 HST, not 4 AM.
      expect(db.tables.callbacks[0].scheduled_at).toBe(
        "2026-09-03T20:00:00.000Z",
      );
    }
  });
});

/**
 * The in-call schedule_callback tool is the other writer — and the one that
 * actually produced the prod damage: 248 of the 293 callbacks created since
 * 2026-09-08 came from it, and when it has already booked, the post-call path
 * defers to its row and never looks at its own extraction.
 *
 * Here the dynamic variables DO interpolate — the tool call for the Los Angeles
 * lead above was sent lead_timezone = America/Los_Angeles and
 * current_time = 9:46 AM, both correct — and the model wrote Eastern anyway,
 * following ElevenLabs' own system__time / system__timezone. Different cause,
 * identical symptom, identical cure: ask for minutes, not a clock.
 */
describe("in-call schedule_callback honours a relative callback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://stub";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  async function runTool(body: Record<string, unknown>) {
    const db = makeFakeDb({
      calls: [{ id: "call-1", lead_id: "lead-1", campaign_id: "camp-1" }],
      leads: [
        {
          id: "lead-1",
          owner_id: "owner-1",
          timezone: "America/Los_Angeles",
          status: "new",
        },
      ],
      callbacks: [],
    });
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => db.client,
    }));
    const { executeServerTool } = await import("@/lib/elevenlabs/tool-webhook");
    const result = await executeServerTool("schedule_callback", {
      call_id: "call-1",
      ...body,
    });
    return { result, db };
  }

  it("books 'in an hour' an hour out, not 3 hours late", async () => {
    const now = new Date("2026-09-11T16:47:35.491Z");
    vi.setSystemTime(now);
    const { result, db } = await runTool({
      callback_datetime: MODEL_WROTE,
      callback_relative_minutes: "60",
    });
    expect(result.success).toBe(true);
    // NOT 2026-09-11T20:47:00.000Z, which is what prod stored.
    expect(db.tables.callbacks[0].scheduled_at).toBe(
      new Date(now.getTime() + 60 * 60_000).toISOString(),
    );
  });

  it("still reads a named time in the lead's own zone", async () => {
    vi.setSystemTime(new Date("2026-09-11T16:47:35.491Z"));
    // "later tonight around 5:00" — a real prod call in the same minute. The
    // model stamps Eastern; 17:00 means 5 PM in Los Angeles.
    const { db } = await runTool({
      callback_datetime: "2026-09-11T17:00:00-04:00",
    });
    expect(db.tables.callbacks[0].scheduled_at).toBe(
      "2026-09-12T00:00:00.000Z",
    );
  });

  it("holds a one-minute relative callback to the floor", async () => {
    const now = new Date("2026-09-11T16:47:35.491Z");
    vi.setSystemTime(now);
    const { db } = await runTool({
      callback_datetime: MODEL_WROTE,
      callback_relative_minutes: "1",
    });
    expect(db.tables.callbacks[0].scheduled_at).toBe(
      new Date(now.getTime() + CALLBACK_FLOOR_MS).toISOString(),
    );
  });
});
