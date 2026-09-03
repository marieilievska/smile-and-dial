import { createHmac } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  leadStatusAfterInviteeCreated,
  verifyCalendlySignature,
} from "@/lib/calendly/webhook";

const KEY = "test-signing-key";
const BODY = JSON.stringify({
  event: "invitee.created",
  payload: { uri: "x" },
});
const NOW_MS = 1_756_900_000_000; // fixed "now"
const NOW_SECS = Math.floor(NOW_MS / 1000);

function sign(body: string, key: string, t: number): string {
  const v1 = createHmac("sha256", key).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

describe("verifyCalendlySignature", () => {
  test("a valid signature passes", () => {
    expect(
      verifyCalendlySignature(BODY, sign(BODY, KEY, NOW_SECS), KEY, NOW_MS),
    ).toEqual({ ok: true });
  });

  test("a signature made with the wrong key is a mismatch", () => {
    expect(
      verifyCalendlySignature(
        BODY,
        sign(BODY, "wrong-key", NOW_SECS),
        KEY,
        NOW_MS,
      ),
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  test("a missing header is reported as missing", () => {
    expect(verifyCalendlySignature(BODY, null, KEY, NOW_MS)).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(verifyCalendlySignature(BODY, "", KEY, NOW_MS)).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  test("a garbage header is malformed", () => {
    expect(verifyCalendlySignature(BODY, "garbage", KEY, NOW_MS)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(
      verifyCalendlySignature(BODY, "t=notanumber,v1=abc", KEY, NOW_MS),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  test("a timestamp older than the tolerance is expired", () => {
    const old = NOW_SECS - 181;
    expect(
      verifyCalendlySignature(BODY, sign(BODY, KEY, old), KEY, NOW_MS, 180),
    ).toEqual({ ok: false, reason: "expired" });
  });

  test("a body tampered with after signing is a mismatch", () => {
    const header = sign(BODY, KEY, NOW_SECS);
    const tampered = BODY.replace("invitee.created", "invitee.canceled");
    expect(verifyCalendlySignature(tampered, header, KEY, NOW_MS)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });
});

describe("leadStatusAfterInviteeCreated", () => {
  test("a goal_met lead is left alone (null)", () => {
    expect(leadStatusAfterInviteeCreated("goal_met")).toBeNull();
  });

  test.each(["scheduled", "new", "callback", null, undefined])(
    "status %s becomes scheduled",
    (current) => {
      expect(leadStatusAfterInviteeCreated(current)).toBe("scheduled");
    },
  );
});
