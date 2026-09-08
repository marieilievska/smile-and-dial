import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The buy side of local presence: `addNumbersToPool` must never substitute an
 * out-of-state number for the one that was asked for.
 *
 * This runs the REAL action against the real Twilio mock (`numbers.ts` only
 * touches Twilio when TWILIO_LIVE=live, so a purchase here costs nothing), and
 * asserts on what actually reached the `twilio_numbers` insert. Only the
 * effects that cannot run under Vitest are stubbed: Next's cache, the Supabase
 * client, and the ElevenLabs / SHAKEN side-effects.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/twilio/place-call", () => ({
  ensureNumberImportedToElevenLabs: vi
    .fn()
    .mockResolvedValue({ ok: true, phoneNumberId: "pn_test" }),
  assignAgentToNumber: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/twilio/shaken", () => ({
  assignNumberToShaken: vi.fn().mockResolvedValue({ ok: true, skipped: false }),
  logShakenSignFailure: vi.fn().mockResolvedValue(undefined),
}));

/** Records every twilio_numbers insert so the test can see which area codes
 *  were actually bought. Covers only the calls addNumbersToPool makes. */
const inserted: Array<Record<string, unknown>> = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } } }),
    },
    from(table: string) {
      if (table === "campaigns") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: "camp-1",
                  owner_id: "user-1",
                  agent: { elevenlabs_agent_id: "el_agent_1" },
                },
              }),
            }),
          }),
        };
      }
      if (table === "twilio_numbers") {
        return {
          insert: (row: Record<string, unknown>) => {
            inserted.push(row);
            return {
              select: () => ({
                single: async () => ({
                  data: { id: `num-${inserted.length}` },
                  error: null,
                }),
              }),
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

import { regionForAreaCode } from "@/lib/dialer/nanp-states";
import { addNumbersToPool } from "@/lib/twilio/pool-actions";

/** The area codes actually bought, in order. */
const boughtAreaCodes = () => inserted.map((r) => r.area_code as string);

beforeEach(() => {
  inserted.length = 0;
});

describe("addNumbersToPool locality", () => {
  it("asking for DC never buys a Virginia or Maryland number", async () => {
    // Confirmed live on 2026-09-08: a one-per-state buy asked for DC and was
    // offered +1571…, a second Virginia number. 202's metro peers are all
    // out-of-state, so the fallback used to leave DC before it ever tried
    // DC's own overlay, 771.
    //
    // 8 is deliberately more than one area code can supply, to force the
    // fallback that carried the bug.
    const res = await addNumbersToPool({
      campaignId: "camp-1",
      areaCode: "202",
      count: 8,
    });

    expect(res.error).toBeNull();
    expect(res.bought).toBeGreaterThan(0);
    for (const ac of boughtAreaCodes()) {
      expect(regionForAreaCode(ac), `bought ${ac}`).toBe("DC");
    }
    expect(boughtAreaCodes()).not.toContain("571");
    expect(boughtAreaCodes()).not.toContain("703");
  });

  it("asking for Kansas City, Missouri never buys the Kansas side", async () => {
    const res = await addNumbersToPool({
      campaignId: "camp-1",
      areaCode: "816",
      count: 8,
    });

    expect(res.error).toBeNull();
    expect(boughtAreaCodes()).not.toContain("913");
    for (const ac of boughtAreaCodes()) {
      expect(regionForAreaCode(ac), `bought ${ac}`).toBe("MO");
    }
  });

  it("reports the shortfall instead of substituting across a state line", async () => {
    // DC has exactly two area codes and the Twilio mock offers five per code,
    // so a request for 12 can only ever be filled ten deep. The remaining two
    // must come back as a reported shortfall, not as Virginia numbers.
    const res = await addNumbersToPool({
      campaignId: "camp-1",
      areaCode: "202",
      count: 12,
    });

    expect(res.bought).toBe(10);
    expect(res.requested).toBe(12);
    expect(res.unavailable).toBe(2);
    expect(res.error).toBeNull();
    for (const ac of boughtAreaCodes()) {
      expect(regionForAreaCode(ac), `bought ${ac}`).toBe("DC");
    }
  });

  it("still falls back within the state when the exact code is short", async () => {
    // The guard must not become "exact code only" — 305 short still reaches
    // its South Florida neighbours.
    const res = await addNumbersToPool({
      campaignId: "camp-1",
      areaCode: "305",
      count: 8,
    });

    expect(res.bought).toBe(8);
    expect(new Set(boughtAreaCodes()).size).toBeGreaterThan(1);
    for (const ac of boughtAreaCodes()) {
      expect(regionForAreaCode(ac), `bought ${ac}`).toBe("FL");
    }
  });
});
