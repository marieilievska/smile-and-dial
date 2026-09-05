import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Pure helpers for the Close inbound webhook route (no server-only, no
 * supabase) so the signature check and the payload parsing are unit-tested.
 *
 * Close signs every delivery with the subscription's `signature_key`
 * (returned once by POST /api/v1/webhook/):
 *   close-sig-timestamp: <unix seconds>
 *   close-sig-hash:      hex( HMAC-SHA256( fromhex(signature_key),
 *                                          timestamp + rawBody ) )
 * The key is a hex string and is HEX-DECODED before use — Close's reference
 * verifier is `hmac.new(bytearray.fromhex(key), (timestamp + payload), sha256)`.
 *
 * A delivery is `{ event: { object_type, action, data, lead_id, ... },
 * subscription_id }`. We subscribe to `activity.email created` and
 * `activity.sms created`; both fire for OUTBOUND messages too, so the parser
 * keeps only `direction: "incoming"` emails and `direction: "inbound"` SMS.
 */

/** The events the app subscribes to. Exported so the subscription is created
 *  from the same list the parser accepts. */
export const CLOSE_WEBHOOK_EVENTS = [
  { object_type: "activity.email", action: "created" },
  { object_type: "activity.sms", action: "created" },
] as const;

export type CloseSignatureResult =
  | { ok: true }
  | {
      ok: false;
      reason: "missing" | "malformed" | "expired" | "mismatch";
    };

/** Deliveries older (or newer) than this are rejected as replays. */
export const CLOSE_SIGNATURE_TOLERANCE_SECS = 300;

export function verifyCloseSignature(
  rawBody: string,
  timestampHeader: string | null,
  hashHeader: string | null,
  signatureKey: string,
  nowMs: number,
  toleranceSecs = CLOSE_SIGNATURE_TOLERANCE_SECS,
): CloseSignatureResult {
  if (!timestampHeader || !hashHeader) return { ok: false, reason: "missing" };
  const t = timestampHeader.trim();
  const given = hashHeader.trim().toLowerCase();
  if (!/^\d+$/.test(t) || !/^[0-9a-f]{64}$/.test(given)) {
    return { ok: false, reason: "malformed" };
  }
  const ts = Number(t);
  if (Math.abs(Math.floor(nowMs / 1000) - ts) > toleranceSecs) {
    return { ok: false, reason: "expired" };
  }
  const expected = createHmac("sha256", closeSignatureKeyBytes(signatureKey))
    .update(t + rawBody, "utf8")
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}

/** Close's signature_key is hex; the HMAC key is its decoded bytes. A key that
 *  isn't valid hex is used verbatim (it will simply never verify), so a bad
 *  stored value fails closed instead of throwing. */
function closeSignatureKeyBytes(key: string): Buffer {
  const k = key.trim();
  return /^[0-9a-f]+$/i.test(k) && k.length % 2 === 0
    ? Buffer.from(k, "hex")
    : Buffer.from(k, "utf8");
}

export type CloseInboundEmail = {
  kind: "email";
  /** The Close email activity id — our `emails.close_message_id`. */
  closeMessageId: string;
  /** The bare, lowercased sender address (extracted from "Name <addr>"). */
  senderEmail: string | null;
  /** The sender exactly as Close sent it. */
  senderRaw: string | null;
  to: string | null;
  subject: string | null;
  body: string | null;
  /** Close activity id of the email this replies to, when Close threaded it. */
  inReplyToId: string | null;
  /** Close's thread id — the FIRST activity's id in the thread. */
  threadId: string | null;
  raw: Record<string, unknown>;
};

export type CloseInboundSms = {
  kind: "sms";
  /** The Close SMS activity id — our `texts.close_message_id`. */
  closeMessageId: string;
  /** The other party — for an inbound SMS, the lead's number (E.164). */
  fromNumber: string | null;
  /** Our Close number. */
  toNumber: string | null;
  text: string;
  raw: Record<string, unknown>;
};

export type CloseWebhookIgnored = {
  kind: "ignored";
  reason:
    | "no_event"
    | "not_created"
    | "unsupported_object_type"
    | "email_not_incoming"
    | "sms_not_inbound"
    | "missing_activity_id";
};

export type CloseWebhookParsed =
  | CloseInboundEmail
  | CloseInboundSms
  | CloseWebhookIgnored;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Classify a parsed delivery body into the one inbound email / SMS we act
 *  on, or an `ignored` result with the reason. Never throws on odd shapes. */
export function parseCloseWebhookEvent(body: unknown): CloseWebhookParsed {
  if (!isRecord(body) || !isRecord(body.event)) {
    return { kind: "ignored", reason: "no_event" };
  }
  const event = body.event;
  if (event.action !== "created") {
    return { kind: "ignored", reason: "not_created" };
  }
  const data = isRecord(event.data) ? event.data : {};
  const objectType = event.object_type;

  if (objectType === "activity.email") {
    if (data.direction !== "incoming") {
      return { kind: "ignored", reason: "email_not_incoming" };
    }
    const id = str(data.id) ?? str(event.object_id);
    if (!id) return { kind: "ignored", reason: "missing_activity_id" };
    const senderRaw = str(data.sender) ?? envelopeFrom(data.envelope);
    const to = Array.isArray(data.to)
      ? (data.to.filter((x) => typeof x === "string") as string[]).join(", ") ||
        null
      : str(data.to);
    return {
      kind: "email",
      closeMessageId: id,
      senderEmail: senderRaw ? extractEmailAddress(senderRaw) : null,
      senderRaw,
      to,
      subject: str(data.subject),
      body: str(data.body_text) ?? str(data.body_html),
      inReplyToId: str(data.in_reply_to_id) ?? str(data.in_reply_to),
      threadId: str(data.thread_id),
      raw: data,
    };
  }

  if (objectType === "activity.sms") {
    if (data.direction !== "inbound") {
      return { kind: "ignored", reason: "sms_not_inbound" };
    }
    const id = str(data.id) ?? str(event.object_id);
    if (!id) return { kind: "ignored", reason: "missing_activity_id" };
    return {
      kind: "sms",
      closeMessageId: id,
      fromNumber: str(data.remote_phone),
      toNumber: str(data.local_phone),
      text: typeof data.text === "string" ? data.text : "",
      raw: data,
    };
  }

  return { kind: "ignored", reason: "unsupported_object_type" };
}

/** `envelope.from[0].email` — the address Close parsed off the wire, used
 *  when `sender` is absent on a synced incoming email. */
function envelopeFrom(envelope: unknown): string | null {
  if (!isRecord(envelope) || !Array.isArray(envelope.from)) return null;
  const first = envelope.from[0];
  return isRecord(first) ? str(first.email) : null;
}

/** Pull the bare address out of "Name <addr>", "<addr>", or a plain address,
 *  lowercased. Returns null when nothing address-shaped is present. */
export function extractEmailAddress(value: string): string | null {
  const angled = value.match(/<([^<>\s]+@[^<>\s]+)>/);
  const candidate = (angled ? angled[1] : value).trim().replace(/^"|"$/g, "");
  return /^[^\s<>",;@]+@[^\s<>",;@]+\.[^\s<>",;@]+$/.test(candidate)
    ? candidate.toLowerCase()
    : null;
}

/** Escape a literal value for a PostgREST `ilike` filter so `%`, `_` and `\`
 *  in the value can't widen the match. `*` is PostgREST's own `%` alias and
 *  can't be escaped through the client, so callers must skip values holding it. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** True when the value is safe to pass through `escapeLikePattern` + ilike. */
export function isIlikeSafe(value: string): boolean {
  return !value.includes("*") && !value.includes(",");
}

// Carrier-standard opt-out keywords. Carriers also block further SMS to a
// STOP'd number at the network level; catching it here additionally stops
// CALLS and records the opt-out.
const STOP_RE = /^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*$/i;

/** Trailing punctuation stripped so "STOP." / "STOP!" still opt out. Carrier
 *  exact-match keywords only — a plain-language "please stop texting" is left
 *  to the human who sees the text_replied notification. */
export function isStopMessage(text: string): boolean {
  return STOP_RE.test(text.trim().replace(/[.!?]+$/, ""));
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}
