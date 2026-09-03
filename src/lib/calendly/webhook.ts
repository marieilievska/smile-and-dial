import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Pure helpers for the Calendly webhook route (no server-only, no supabase)
 * so the signature check and the lead-status rule can be unit-tested.
 *
 * Calendly signs each delivery with the subscription's signing key:
 *   Calendly-Webhook-Signature: t=<unix seconds>,v1=<hex>
 *   v1 = HMAC-SHA256(signingKey, `${t}.${rawBody}`)
 */

export type CalendlyWebhookPayload = {
  event?: string;
  payload?: {
    uri?: string;
    email?: string;
    name?: string;
    text_reminder_number?: string;
    cancel_url?: string;
    reschedule_url?: string;
    /** Set on `invitee.canceled` when the cancel is half of a reschedule. */
    rescheduled?: boolean;
    /** On a rescheduled `invitee.canceled`: the replacement invitee's URI. */
    new_invitee?: string;
    /** On `invitee.created` that replaces an earlier booking: the old URI. */
    old_invitee?: string;
    scheduled_event?: {
      uri?: string;
      start_time?: string;
      event_type?: string;
    };
  };
};

export type CalendlySignatureResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "malformed" | "expired" | "mismatch" };

export function verifyCalendlySignature(
  rawBody: string,
  header: string | null,
  signingKey: string,
  nowMs: number,
  toleranceSecs = 180,
): CalendlySignatureResult {
  if (!header) return { ok: false, reason: "missing" };

  let t: string | null = null;
  let v1: string | null = null;
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") v1 = v;
  }
  if (!t || !v1 || !/^\d+$/.test(t) || !/^[0-9a-f]+$/i.test(v1)) {
    return { ok: false, reason: "malformed" };
  }

  const ts = Number(t);
  if (Math.abs(Math.floor(nowMs / 1000) - ts) > toleranceSecs) {
    return { ok: false, reason: "expired" };
  }

  const expected = createHmac("sha256", signingKey)
    .update(`${t}.${rawBody}`)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(v1.toLowerCase(), "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}

/**
 * Lead status to write after `invitee.created`, or null to leave it alone.
 * `goal_met` is the confirmed-booking status set by the post-call flow; a
 * host-side reschedule re-fires `invitee.created` and must not downgrade it.
 */
export function leadStatusAfterInviteeCreated(
  currentStatus: string | null | undefined,
): string | null {
  return currentStatus === "goal_met" ? null : "scheduled";
}
