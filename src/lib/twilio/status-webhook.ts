import "server-only";

import { createHmac } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { applyRetryForCall } from "@/lib/dialer/retry-engine";
import type { Database } from "@/lib/supabase/database.types";

type SupabaseAdmin = ReturnType<typeof createClient<Database>>;
type CallStatusRow = Database["public"]["Tables"]["calls"]["Row"]["status"];
type CallOutcome = Database["public"]["Tables"]["calls"]["Row"]["outcome"];

/**
 * The CallStatus values Twilio sends in status callbacks. The webhook fires
 * on every transition; we map each to a row update.
 *
 * See https://www.twilio.com/docs/voice/twiml#callstatus-values
 */
export type TwilioCallStatus =
  | "queued"
  | "initiated"
  | "ringing"
  | "answered"
  | "in-progress"
  | "completed"
  | "busy"
  | "failed"
  | "no-answer"
  | "canceled";

const TWILIO_TO_DB_STATUS: Record<TwilioCallStatus, CallStatusRow> = {
  queued: "queued",
  initiated: "dialing",
  ringing: "ringing",
  answered: "in_progress",
  "in-progress": "in_progress",
  completed: "completed",
  busy: "completed",
  failed: "failed",
  "no-answer": "completed",
  canceled: "cancelled",
};

const TERMINAL: TwilioCallStatus[] = [
  "completed",
  "busy",
  "failed",
  "no-answer",
  "canceled",
];

// Status values that carry an automatic outcome inference. `completed` alone
// doesn't — the actual outcome comes from ElevenLabs (Step 23).
const STATUS_TO_OUTCOME: Partial<Record<TwilioCallStatus, CallOutcome>> = {
  busy: "busy",
  "no-answer": "no_answer",
  failed: "failed",
};

/**
 * Validate Twilio's X-Twilio-Signature header.
 *
 * Twilio signs `url + sorted(params)` with HMAC-SHA1 using the auth token.
 * In mock mode (TWILIO_LIVE != "live"), validation is skipped entirely so
 * tests can synthesize webhook calls without a real auth token.
 */
export function isValidTwilioSignature(input: {
  url: string;
  params: Record<string, string>;
  signature: string | null;
}): boolean {
  if (process.env.TWILIO_LIVE !== "live") return true;
  if (!input.signature) return false;
  const token = process.env.TWILIO_AUTH_TOKEN ?? "";
  if (!token) return false;

  // Twilio's algorithm: sort param keys, concatenate key+value, prepend the
  // request URL, HMAC-SHA1 with the auth token, base64-encode.
  const sortedKeys = Object.keys(input.params).sort();
  const data = input.url + sortedKeys.map((k) => k + input.params[k]).join("");
  const expected = createHmac("sha1", token).update(data).digest("base64");

  // Constant-time compare — tiny, but easy enough to do right.
  if (expected.length !== input.signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ input.signature.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Build a service-role client tied to the project URL + service role key. */
function makeServiceClient(): SupabaseAdmin {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    throw new Error(
      "Twilio webhook requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export type ProcessResult =
  | { ok: true; status: "applied" }
  | { ok: true; status: "duplicate" }
  | { ok: true; status: "unknown_call" }
  | { ok: false; reason: string };

/**
 * Process one Twilio status callback. Idempotent on (CallSid, CallStatus):
 * if we've already processed this event, we return `duplicate` without
 * touching the call row. If we don't know about the CallSid, we return
 * `unknown_call` (might be a call placed by a different system).
 */
export async function processTwilioStatus(input: {
  callSid: string;
  callStatus: TwilioCallStatus;
  rawPayload: Record<string, string>;
}): Promise<ProcessResult> {
  if (!input.callSid) return { ok: false, reason: "missing_call_sid" };
  if (!TWILIO_TO_DB_STATUS[input.callStatus]) {
    return { ok: false, reason: "unknown_call_status" };
  }

  const supabase = makeServiceClient();

  // Idempotency guard: try to claim the (call_sid, event_type) row first.
  const { error: insertError } = await supabase
    .from("twilio_status_events")
    .insert({
      call_sid: input.callSid,
      event_type: input.callStatus,
      raw_payload: input.rawPayload,
    });
  if (insertError) {
    // 23505 = unique_violation → we've already processed this event.
    if ((insertError as { code?: string }).code === "23505") {
      return { ok: true, status: "duplicate" };
    }
    return { ok: false, reason: "could_not_log_event" };
  }

  // Look up the call row by Twilio's CallSid.
  const { data: call } = await supabase
    .from("calls")
    .select("id, status, started_at, answered_at")
    .eq("twilio_call_sid", input.callSid)
    .maybeSingle();
  if (!call) return { ok: true, status: "unknown_call" };

  const now = new Date().toISOString();
  const nextStatus = TWILIO_TO_DB_STATUS[input.callStatus];
  const update: Partial<Database["public"]["Tables"]["calls"]["Update"]> = {
    status: nextStatus,
  };

  // First time we hear the call has started ringing or being dialed: stamp
  // started_at.
  if (
    !call.started_at &&
    (input.callStatus === "initiated" || input.callStatus === "ringing")
  ) {
    update.started_at = now;
  }
  // First time we hear it was answered: stamp answered_at.
  if (
    !call.answered_at &&
    (input.callStatus === "answered" || input.callStatus === "in-progress")
  ) {
    update.answered_at = now;
  }
  // Any terminal status stamps ended_at and (where Twilio's status alone
  // determines it) the outcome.
  if (TERMINAL.includes(input.callStatus)) {
    update.ended_at = now;
    const inferredOutcome = STATUS_TO_OUTCOME[input.callStatus];
    if (inferredOutcome) {
      update.outcome = inferredOutcome;
      update.outcome_source = "twilio";
    }

    // Duration from Twilio's payload (seconds, integer). Some events omit it.
    const dur = Number(input.rawPayload.CallDuration ?? "");
    if (Number.isFinite(dur) && dur > 0) update.duration_seconds = dur;
  }

  const { error: updateError } = await supabase
    .from("calls")
    .update(update)
    .eq("id", call.id);
  if (updateError) return { ok: false, reason: "could_not_update_call" };

  // If we just stamped a terminal status with an inferred outcome
  // (busy / no-answer / failed), fire the retry engine so the lead's
  // next_call_at / retry_counter / status get updated. ElevenLabs's
  // post-call webhook may also fire for the same call; the engine is
  // idempotent and whichever wins the compare-and-swap races first.
  if (update.outcome) {
    await applyRetryForCall(call.id);
  }

  return { ok: true, status: "applied" };
}
