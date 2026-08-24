import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getElevenLabsCreditBalance } from "@/lib/elevenlabs/subscription";

const OLD_KEY = process.env.ELEVENLABS_API_KEY;

beforeEach(() => {
  process.env.ELEVENLABS_API_KEY = "test-key";
});
afterEach(() => {
  process.env.ELEVENLABS_API_KEY = OLD_KEY;
  vi.unstubAllGlobals();
});

describe("getElevenLabsCreditBalance", () => {
  it("returns remaining = limit - used from the subscription payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          character_limit: 2_000_000,
          character_count: 1_950_000,
          tier: "growing_business",
          status: "active",
          next_character_count_reset_unix: 1_800_000_000,
        }),
      }),
    );
    const bal = await getElevenLabsCreditBalance();
    expect(bal).toEqual({
      remaining: 50_000,
      limit: 2_000_000,
      used: 1_950_000,
      tier: "growing_business",
      status: "active",
      resetUnix: 1_800_000_000,
    });
  });

  it("clamps remaining to 0 when usage exceeds the limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ character_limit: 100, character_count: 250 }),
      }),
    );
    const bal = await getElevenLabsCreditBalance();
    expect(bal?.remaining).toBe(0);
  });

  it("returns null on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
    );
    expect(await getElevenLabsCreditBalance()).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    expect(await getElevenLabsCreditBalance()).toBeNull();
  });

  it("returns null when the payload has no numeric limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
    );
    expect(await getElevenLabsCreditBalance()).toBeNull();
  });

  it("returns null when no API key is configured", async () => {
    process.env.ELEVENLABS_API_KEY = "";
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await getElevenLabsCreditBalance()).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
