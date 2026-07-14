import { test, expect } from "@playwright/test";

import { planEmailSend } from "../src/lib/close/email-send-plan";

test.describe("planEmailSend — send_email honesty matrix", () => {
  test("non-live records a mock row and reports sent", () => {
    expect(
      planEmailSend({ live: false, hasCloseKey: false, delivered: null }),
    ).toEqual({ action: "record_mock" });
  });

  test("live without a Close connection notes only — never a fake sent", () => {
    expect(
      planEmailSend({ live: true, hasCloseKey: false, delivered: null }),
    ).toEqual({ action: "note_only", reason: "owner_close_not_connected" });
  });

  test("live + connected + delivered records the real send", () => {
    expect(
      planEmailSend({ live: true, hasCloseKey: true, delivered: { ok: true } }),
    ).toEqual({ action: "record_real" });
  });

  test("live + connected + delivery failed notes only with the reason", () => {
    expect(
      planEmailSend({
        live: true,
        hasCloseKey: true,
        delivered: { ok: false, error: "no_connected_sending_email" },
      }),
    ).toEqual({ action: "note_only", reason: "no_connected_sending_email" });
  });
});
