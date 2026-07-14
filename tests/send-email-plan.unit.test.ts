import { describe, expect, it } from "vitest";

import { planEmailSend } from "../src/lib/close/email-send-plan";

describe("planEmailSend — send_email honesty matrix", () => {
  it("non-live records a mock row and reports sent", () => {
    expect(
      planEmailSend({ live: false, hasCloseKey: false, delivered: null }),
    ).toEqual({ action: "record_mock" });
  });

  it("live without a Close connection notes only — never a fake sent", () => {
    expect(
      planEmailSend({ live: true, hasCloseKey: false, delivered: null }),
    ).toEqual({ action: "note_only", reason: "owner_close_not_connected" });
  });

  it("live + connected + delivered records the real send", () => {
    expect(
      planEmailSend({ live: true, hasCloseKey: true, delivered: { ok: true } }),
    ).toEqual({ action: "record_real" });
  });

  it("live + connected + delivery failed notes only with the reason", () => {
    expect(
      planEmailSend({
        live: true,
        hasCloseKey: true,
        delivered: { ok: false, error: "no_connected_sending_email" },
      }),
    ).toEqual({ action: "note_only", reason: "no_connected_sending_email" });
  });
});
