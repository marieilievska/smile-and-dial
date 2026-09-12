import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  refreshAvailabilityCopy,
  resolveOfferableSlots,
  type AvailabilityCopy,
} from "../src/lib/calendly/copy-store";

/** Minimal Supabase double: records the update it was asked to make. */
function fakeSupabase() {
  const updates: Record<string, unknown>[] = [];
  return {
    updates,
    client: {
      from() {
        return {
          update(values: Record<string, unknown>) {
            updates.push(values);
            return { eq: async () => ({ error: null }) };
          },
        };
      },
    } as never,
  };
}

const TARGET = {
  eventTypeId: "11111111-1111-1111-1111-111111111111",
  eventTypeUri: "https://api.calendly.com/event_types/abc",
  token: "cal-token",
};
const NOW = Date.parse("2026-09-14T15:00:00Z");
const inHours = (h: number) => new Date(NOW + h * 3600_000).toISOString();

function calendlyReturns(slots: string[]) {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          collection: slots.map((s) => ({
            status: "available",
            start_time: s,
          })),
        }),
        { status: 200 },
      ),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("refreshAvailabilityCopy", () => {
  it("stores what Calendly returned, stamped with the time of the read", async () => {
    global.fetch = calendlyReturns([inHours(3), inHours(27)]) as never;
    const sb = fakeSupabase();
    const result = await refreshAvailabilityCopy(sb.client, TARGET, NOW);
    expect(result).toEqual({ ok: true, slots: [inHours(3), inHours(27)] });
    expect(sb.updates).toHaveLength(1);
    expect(sb.updates[0]).toEqual({
      availability_slots: [inHours(3), inHours(27)],
      availability_fetched_at: new Date(NOW).toISOString(),
    });
  });

  it("stores an empty list when Calendly says nothing is open", async () => {
    global.fetch = calendlyReturns([]) as never;
    const sb = fakeSupabase();
    await refreshAvailabilityCopy(sb.client, TARGET, NOW);
    expect(sb.updates[0].availability_slots).toEqual([]);
  });

  it("leaves the previous copy alone when Calendly does not answer", async () => {
    global.fetch = vi.fn(
      async () => new Response("nope", { status: 503 }),
    ) as never;
    const sb = fakeSupabase();
    const result = await refreshAvailabilityCopy(sb.client, TARGET, NOW);
    expect(result.ok).toBe(false);
    expect(sb.updates).toHaveLength(0);
  });

  it("never throws, even when the write fails", async () => {
    global.fetch = calendlyReturns([inHours(3)]) as never;
    const client = {
      from() {
        return {
          update() {
            return {
              eq: async () => {
                throw new Error("database down");
              },
            };
          },
        };
      },
    } as never;
    await expect(refreshAvailabilityCopy(client, TARGET, NOW)).resolves.toEqual(
      {
        ok: true,
        slots: [inHours(3)],
      },
    );
  });
});

describe("resolveOfferableSlots", () => {
  const copy = (
    fetchedAt: string | null,
    slots: string[],
  ): AvailabilityCopy => ({ ...TARGET, slots, fetchedAt });

  it("serves a fresh copy without calling Calendly at all", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as never;
    const sb = fakeSupabase();
    const out = await resolveOfferableSlots(
      sb.client,
      copy(new Date(NOW - 30_000).toISOString(), [inHours(3), inHours(27)]),
      NOW,
    );
    expect(out.source).toBe("copy");
    expect(out.slots).toEqual([inHours(3), inHours(27)]);
    expect(out.copyAgeS).toBe(30);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("drops slots that have passed or start too soon, even from a fresh copy", async () => {
    global.fetch = vi.fn() as never;
    const sb = fakeSupabase();
    const out = await resolveOfferableSlots(
      sb.client,
      copy(new Date(NOW).toISOString(), [
        inHours(-2),
        inHours(0.01),
        inHours(3),
      ]),
      NOW,
    );
    expect(out.slots).toEqual([inHours(3)]);
  });

  it("serves a usable copy AND refreshes it for the next caller", async () => {
    const fetchSpy = calendlyReturns([inHours(4)]);
    global.fetch = fetchSpy as never;
    const sb = fakeSupabase();
    const out = await resolveOfferableSlots(
      sb.client,
      copy(new Date(NOW - 5 * 60_000).toISOString(), [inHours(3)]),
      NOW,
    );
    // The caller is answered from the copy…
    expect(out.source).toBe("copy");
    expect(out.slots).toEqual([inHours(3)]);
    // …and the refresh happens (inline here, after the response in a request).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sb.updates).toHaveLength(1);
  });

  it("fetches live when there is no copy yet, and stores what it got", async () => {
    global.fetch = calendlyReturns([inHours(2)]) as never;
    const sb = fakeSupabase();
    const out = await resolveOfferableSlots(sb.client, copy(null, []), NOW);
    expect(out.source).toBe("live");
    expect(out.slots).toEqual([inHours(2)]);
    expect(sb.updates).toHaveLength(1);
  });

  it("falls back to an hour-old copy when Calendly will not answer", async () => {
    global.fetch = vi.fn(
      async () => new Response("", { status: 500 }),
    ) as never;
    const sb = fakeSupabase();
    const out = await resolveOfferableSlots(
      sb.client,
      copy(new Date(NOW - 30 * 60_000).toISOString(), [inHours(3)]),
      NOW,
    );
    expect(out.source).toBe("stale_fallback");
    expect(out.slots).toEqual([inHours(3)]);
  });

  it("offers nothing when Calendly will not answer and the copy is too old", async () => {
    global.fetch = vi.fn(
      async () => new Response("", { status: 500 }),
    ) as never;
    const sb = fakeSupabase();
    const out = await resolveOfferableSlots(
      sb.client,
      copy(new Date(NOW - 3 * 3600_000).toISOString(), [inHours(3)]),
      NOW,
    );
    expect(out.source).toBe("none");
    expect(out.slots).toEqual([]);
  });
});
