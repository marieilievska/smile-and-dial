import { createHmac } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  CLOSE_WEBHOOK_EVENTS,
  escapeLikePattern,
  extractEmailAddress,
  isIlikeSafe,
  isStopMessage,
  isUuid,
  parseCloseWebhookEvent,
  verifyCloseSignature,
} from "@/lib/close/webhook";

// A signature_key exactly as Close returns it: 64 hex chars (32 bytes).
const KEY = "058bfb6a3d8cfdc4da7c3be5901b16ae11da982b46a25fb2cd7016e97a140a1c";
const WRONG_KEY =
  "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const NOW_MS = 1_756_900_000_000; // fixed "now"
const NOW_SECS = Math.floor(NOW_MS / 1000);

function emailDelivery(data: Record<string, unknown>) {
  return {
    event: {
      id: "ev_1",
      object_type: "activity.email",
      action: "created",
      object_id: "acti_email_1",
      lead_id: "lead_abc",
      data: { id: "acti_email_1", ...data },
    },
    subscription_id: "whsub_1",
  };
}

function smsDelivery(data: Record<string, unknown>) {
  return {
    event: {
      id: "ev_2",
      object_type: "activity.sms",
      action: "created",
      object_id: "acti_sms_1",
      lead_id: "lead_abc",
      data: { id: "acti_sms_1", ...data },
    },
    subscription_id: "whsub_1",
  };
}

const BODY = JSON.stringify(
  emailDelivery({ direction: "incoming", sender: "pat@acme.com" }),
);

/** Sign exactly the way Close's reference verifier expects:
 *  HMAC-SHA256(fromhex(key), timestamp + body) as hex. */
function sign(body: string, keyHex: string, t: number): string {
  return createHmac("sha256", Buffer.from(keyHex, "hex"))
    .update(String(t) + body)
    .digest("hex");
}

describe("verifyCloseSignature", () => {
  test("a valid signature passes (key is hex-decoded before HMAC)", () => {
    expect(
      verifyCloseSignature(
        BODY,
        String(NOW_SECS),
        sign(BODY, KEY, NOW_SECS),
        KEY,
        NOW_MS,
      ),
    ).toEqual({ ok: true });
  });

  test("the hash header is accepted case-insensitively", () => {
    expect(
      verifyCloseSignature(
        BODY,
        String(NOW_SECS),
        sign(BODY, KEY, NOW_SECS).toUpperCase(),
        KEY,
        NOW_MS,
      ),
    ).toEqual({ ok: true });
  });

  test("a signature made with the wrong key is a mismatch", () => {
    expect(
      verifyCloseSignature(
        BODY,
        String(NOW_SECS),
        sign(BODY, WRONG_KEY, NOW_SECS),
        KEY,
        NOW_MS,
      ),
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  test("HMAC over the utf8 key string (not hex-decoded) does NOT verify", () => {
    // Guards the hex-decode: Close's sample uses bytearray.fromhex(key).
    const utf8Keyed = createHmac("sha256", KEY)
      .update(String(NOW_SECS) + BODY)
      .digest("hex");
    expect(
      verifyCloseSignature(BODY, String(NOW_SECS), utf8Keyed, KEY, NOW_MS),
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  test("a stale timestamp is expired, and a future one too", () => {
    const old = NOW_SECS - 301;
    expect(
      verifyCloseSignature(
        BODY,
        String(old),
        sign(BODY, KEY, old),
        KEY,
        NOW_MS,
      ),
    ).toEqual({ ok: false, reason: "expired" });
    const future = NOW_SECS + 301;
    expect(
      verifyCloseSignature(
        BODY,
        String(future),
        sign(BODY, KEY, future),
        KEY,
        NOW_MS,
      ),
    ).toEqual({ ok: false, reason: "expired" });
    // Inside the window is fine.
    const recent = NOW_SECS - 299;
    expect(
      verifyCloseSignature(
        BODY,
        String(recent),
        sign(BODY, KEY, recent),
        KEY,
        NOW_MS,
      ),
    ).toEqual({ ok: true });
  });

  test("missing headers are reported as missing", () => {
    expect(
      verifyCloseSignature(BODY, null, sign(BODY, KEY, NOW_SECS), KEY, NOW_MS),
    ).toEqual({ ok: false, reason: "missing" });
    expect(
      verifyCloseSignature(BODY, String(NOW_SECS), null, KEY, NOW_MS),
    ).toEqual({ ok: false, reason: "missing" });
    expect(verifyCloseSignature(BODY, "", "", KEY, NOW_MS)).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  test("garbage headers are malformed", () => {
    expect(
      verifyCloseSignature(BODY, "notanumber", "abc", KEY, NOW_MS),
    ).toEqual({ ok: false, reason: "malformed" });
    expect(
      verifyCloseSignature(BODY, String(NOW_SECS), "not-hex", KEY, NOW_MS),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  test("a body tampered with after signing is a mismatch", () => {
    const hash = sign(BODY, KEY, NOW_SECS);
    const tampered = BODY.replace("pat@acme.com", "mallory@evil.com");
    expect(
      verifyCloseSignature(tampered, String(NOW_SECS), hash, KEY, NOW_MS),
    ).toEqual({ ok: false, reason: "mismatch" });
  });

  test("a signature for a different timestamp is a mismatch", () => {
    const hash = sign(BODY, KEY, NOW_SECS - 10);
    expect(
      verifyCloseSignature(BODY, String(NOW_SECS), hash, KEY, NOW_MS),
    ).toEqual({ ok: false, reason: "mismatch" });
  });
});

describe("parseCloseWebhookEvent", () => {
  test("an incoming email is parsed with the sender address extracted", () => {
    const parsed = parseCloseWebhookEvent(
      emailDelivery({
        direction: "incoming",
        sender: "Pat Jones <Pat@Acme.com>",
        to: ["owner@smileanddial.test"],
        subject: "Re: Hello",
        body_text: "Sounds good!",
        body_html: "<p>Sounds good!</p>",
        in_reply_to_id: "acti_sent_1",
        thread_id: "acti_sent_1",
      }),
    );
    expect(parsed).toMatchObject({
      kind: "email",
      closeMessageId: "acti_email_1",
      senderEmail: "pat@acme.com",
      senderRaw: "Pat Jones <Pat@Acme.com>",
      to: "owner@smileanddial.test",
      subject: "Re: Hello",
      body: "Sounds good!",
      inReplyToId: "acti_sent_1",
      threadId: "acti_sent_1",
    });
  });

  test("an email with no sender falls back to envelope.from", () => {
    const parsed = parseCloseWebhookEvent(
      emailDelivery({
        direction: "incoming",
        envelope: { from: [{ email: "pat@acme.com", name: "Pat" }] },
        body_html: "<p>hi</p>",
      }),
    );
    expect(parsed).toMatchObject({
      kind: "email",
      senderEmail: "pat@acme.com",
      body: "<p>hi</p>",
      inReplyToId: null,
      threadId: null,
    });
  });

  test("an OUTGOING email is ignored (created fires for both directions)", () => {
    expect(
      parseCloseWebhookEvent(
        emailDelivery({ direction: "outgoing", sender: "me@us.com" }),
      ),
    ).toEqual({ kind: "ignored", reason: "email_not_incoming" });
  });

  test("an inbound SMS is parsed from remote_phone / local_phone / text", () => {
    expect(
      parseCloseWebhookEvent(
        smsDelivery({
          direction: "inbound",
          remote_phone: "+18183004000",
          local_phone: "+16503334444",
          text: "STOP",
        }),
      ),
    ).toMatchObject({
      kind: "sms",
      closeMessageId: "acti_sms_1",
      fromNumber: "+18183004000",
      toNumber: "+16503334444",
      text: "STOP",
    });
  });

  test("an OUTBOUND SMS is ignored", () => {
    expect(
      parseCloseWebhookEvent(
        smsDelivery({ direction: "outbound", remote_phone: "+1", text: "hi" }),
      ),
    ).toEqual({ kind: "ignored", reason: "sms_not_inbound" });
  });

  test("other object types and actions are ignored", () => {
    expect(
      parseCloseWebhookEvent({
        event: { object_type: "lead", action: "created", data: { id: "x" } },
        subscription_id: "whsub_1",
      }),
    ).toEqual({ kind: "ignored", reason: "unsupported_object_type" });
    expect(
      parseCloseWebhookEvent({
        event: {
          object_type: "activity.email",
          action: "updated",
          data: { id: "x", direction: "incoming" },
        },
      }),
    ).toEqual({ kind: "ignored", reason: "not_created" });
  });

  test("the OLD flat shape (top-level event string) is ignored, not applied", () => {
    expect(
      parseCloseWebhookEvent({
        event: "email.received",
        data: { id: "x", from: "pat@acme.com" },
      }),
    ).toEqual({ kind: "ignored", reason: "no_event" });
  });

  test("garbage bodies never throw", () => {
    for (const body of [null, 42, "str", [], {}, { event: null }]) {
      expect(parseCloseWebhookEvent(body)).toEqual({
        kind: "ignored",
        reason: "no_event",
      });
    }
  });

  test("an activity without an id is ignored", () => {
    expect(
      parseCloseWebhookEvent({
        event: {
          object_type: "activity.sms",
          action: "created",
          data: { direction: "inbound", text: "hi" },
        },
      }),
    ).toEqual({ kind: "ignored", reason: "missing_activity_id" });
  });
});

describe("extractEmailAddress", () => {
  test.each([
    ["Pat Jones <Pat@Acme.com>", "pat@acme.com"],
    ['"Jones, Pat" <pat@acme.com>', "pat@acme.com"],
    ["<pat@acme.com>", "pat@acme.com"],
    ["pat@acme.com", "pat@acme.com"],
    ["  PAT@ACME.COM  ", "pat@acme.com"],
  ])("%s → %s", (input, expected) => {
    expect(extractEmailAddress(input)).toBe(expected);
  });

  test.each(["", "Pat Jones", "not an email", "<>", "a@b"])(
    "%s → null",
    (input) => {
      expect(extractEmailAddress(input)).toBeNull();
    },
  );
});

describe("ilike escaping", () => {
  test("escapes %, _ and backslash", () => {
    expect(escapeLikePattern("a_b%c\\d@x.com")).toBe("a\\_b\\%c\\\\d@x.com");
    expect(escapeLikePattern("plain@x.com")).toBe("plain@x.com");
  });

  test("values with PostgREST's * alias are flagged unsafe", () => {
    expect(isIlikeSafe("pat@acme.com")).toBe(true);
    expect(isIlikeSafe("p*t@acme.com")).toBe(false);
  });
});

describe("isStopMessage", () => {
  test.each(["STOP", "stop", " Stop. ", "STOP!", "unsubscribe", "END", "quit"])(
    "%s opts out",
    (text) => {
      expect(isStopMessage(text)).toBe(true);
    },
  );
  test.each(["please stop texting me", "stop it now", "yes", ""])(
    "%s does not",
    (text) => {
      expect(isStopMessage(text)).toBe(false);
    },
  );
});

describe("subscription events + uuid", () => {
  test("we subscribe to exactly the two events the parser accepts", () => {
    expect(CLOSE_WEBHOOK_EVENTS).toEqual([
      { object_type: "activity.email", action: "created" },
      { object_type: "activity.sms", action: "created" },
    ]);
  });

  test("isUuid", () => {
    expect(isUuid("5c9b4a0e-3f1e-4c7a-9d2b-1a2b3c4d5e6f")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid("5c9b4a0e-3f1e-4c7a-9d2b-1a2b3c4d5e6f' or 1=1")).toBe(false);
  });
});
