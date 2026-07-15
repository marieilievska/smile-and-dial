import { describe, expect, it } from "vitest";

import { planTextSend } from "../src/lib/close/text-send-plan";

describe("planTextSend — send_text honesty matrix", () => {
  it("non-live records a mock row", () => {
    expect(
      planTextSend({
        live: false,
        hasCloseKey: false,
        hasFromNumber: false,
        delivered: null,
      }),
    ).toEqual({ action: "record_mock" });
  });

  it("live without a Close connection notes only", () => {
    expect(
      planTextSend({
        live: true,
        hasCloseKey: false,
        hasFromNumber: false,
        delivered: null,
      }),
    ).toEqual({ action: "note_only", reason: "owner_close_not_connected" });
  });

  it("live + connected but no send-from number notes only", () => {
    expect(
      planTextSend({
        live: true,
        hasCloseKey: true,
        hasFromNumber: false,
        delivered: null,
      }),
    ).toEqual({ action: "note_only", reason: "no_sms_from_number" });
  });

  it("live + connected + from-number + delivered records the real send", () => {
    expect(
      planTextSend({
        live: true,
        hasCloseKey: true,
        hasFromNumber: true,
        delivered: { ok: true },
      }),
    ).toEqual({ action: "record_real" });
  });

  it("live + delivery failed notes only with the reason", () => {
    expect(
      planTextSend({
        live: true,
        hasCloseKey: true,
        hasFromNumber: true,
        delivered: { ok: false, error: "close_exception" },
      }),
    ).toEqual({ action: "note_only", reason: "close_exception" });
  });
});
