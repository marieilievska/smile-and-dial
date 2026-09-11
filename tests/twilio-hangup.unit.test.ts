import { afterEach, describe, expect, it, vi } from "vitest";

import { hangUpCall } from "@/lib/twilio/hangup";

/**
 * Terminating a call at the Twilio layer is our only reliable hangup.
 * ElevenLabs' own end_call is abandoned whenever the caller speaks over it
 * ("Tool execution was abandoned due to user input"), which is exactly how a
 * prank caller held the agent for 843 seconds on 2026-09-11.
 *
 * Nothing here touches a real call: fetch is stubbed, and the off-live guard is
 * asserted so a test run can never reach Twilio even if the env leaks.
 */
const OLD = { ...process.env };
afterEach(() => {
  process.env = { ...OLD };
  vi.unstubAllGlobals();
});

function live() {
  process.env.TWILIO_LIVE = "live";
  process.env.TWILIO_ACCOUNT_SID = "AC_test";
  process.env.TWILIO_API_KEY_SID = "SK_test";
  process.env.TWILIO_API_KEY_SECRET = "secret";
}

describe("hangUpCall", () => {
  it("POSTs Status=completed to the call resource", async () => {
    live();
    const fetchSpy = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => "{}" });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await hangUpCall("CA123");

    expect(res).toEqual({ ok: true, error: null });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/AC_test/Calls/CA123.json",
    );
    expect(init.method).toBe("POST");
    expect(String(init.body)).toBe("Status=completed");
    expect(init.headers.Authorization).toMatch(/^Basic /);
  });

  it("never calls Twilio off-live", async () => {
    process.env.TWILIO_LIVE = "";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(await hangUpCall("CA123")).toEqual({ ok: true, error: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports a Twilio failure instead of throwing", async () => {
    live();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => "not found",
      }),
    );

    const res = await hangUpCall("CA404");

    expect(res.ok).toBe(false);
    expect(res.error).toContain("404");
  });

  it("reports a missing CallSid instead of calling Twilio", async () => {
    live();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await hangUpCall("");

    expect(res.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
