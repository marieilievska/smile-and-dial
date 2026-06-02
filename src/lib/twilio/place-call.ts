import "server-only";

import { appBaseUrl } from "@/lib/app-url";

/** Round L3 — place one real outbound call via Twilio's REST API.
 *
 *  The caller has already done the heavy lifting: validated the lead,
 *  picked the campaign, run the pre-call check. This helper only does
 *  the part that talks to Twilio. It returns the new CallSid (so the
 *  caller can stamp it on the `calls` row) and a typed error message
 *  if anything goes wrong.
 *
 *  The Twilio Call resource accepts a `Url` for inbound TwiML —
 *  Twilio fetches that URL once the call is answered and follows
 *  whatever instructions it returns. We point at our own
 *  `/api/twilio/voice-outbound?call_id=…` route so the TwiML can be
 *  built from the call's database row at request time.
 *
 *  Status callbacks land at `/api/twilio/status` and are signed by
 *  Twilio with the account's Auth Token. Both URLs are derived from
 *  `NEXT_PUBLIC_APP_URL` so a preview deployment and production each
 *  route to themselves automatically.
 *
 *  L3 ships with a simple `<Say>` TwiML for testing. L4 swaps in
 *  `<Connect><Stream>` against ElevenLabs.
 */

const TWILIO_API = "https://api.twilio.com/2010-04-01/Accounts";

function isLive(): boolean {
  return process.env.TWILIO_LIVE === "live";
}

function twilioAuth(): { account: string; header: string } | null {
  const account = process.env.TWILIO_ACCOUNT_SID;
  const keySid = process.env.TWILIO_API_KEY_SID;
  const keySecret = process.env.TWILIO_API_KEY_SECRET;
  if (!account || !keySid || !keySecret) return null;
  return {
    account,
    header: "Basic " + Buffer.from(`${keySid}:${keySecret}`).toString("base64"),
  };
}

export type PlaceCallInput = {
  /** Our internal call_id (a UUID we generated client-side). Passed
   *  through to the TwiML and status URLs so handlers can resolve the
   *  row even if the CallSid hasn't been stored yet. */
  callId: string;
  /** The Twilio number to dial from — must be one this account owns. */
  from: string;
  /** The lead's phone, E.164. */
  to: string;
  /** Optional friendly machine-detection timeout, in ms. Twilio
   *  defaults to 30s; we keep it tight so a voicemail prompt doesn't
   *  burn the whole answer window. */
  amdTimeoutMs?: number;
};

export type PlaceCallResult =
  | { ok: true; twilioCallSid: string }
  | { ok: false; error: string };

/** Place one outbound call via Twilio. Mocked unless TWILIO_LIVE=live. */
export async function placeLiveCall(
  input: PlaceCallInput,
): Promise<PlaceCallResult> {
  if (!isLive()) {
    // In mock mode return a deterministic-looking fake SID so the rest
    // of the pipeline has something to write. Tests never run live.
    return {
      ok: true,
      twilioCallSid: `CA${input.callId.replace(/-/g, "").slice(0, 32)}`,
    };
  }
  const auth = twilioAuth();
  if (!auth) {
    return { ok: false, error: "Twilio is not configured (missing creds)." };
  }
  const base = appBaseUrl();
  if (!base) {
    return {
      ok: false,
      error: "Deployment URL isn't configured; cannot build webhook URLs.",
    };
  }

  // Build the TwiML and status URLs with our internal call_id so the
  // handlers can resolve the database row from query params alone.
  // Using a query string keeps the URLs cacheable at Twilio without
  // having to look up the CallSid → call_id mapping on every callback.
  const twimlUrl = `${base}/api/twilio/voice-outbound?call_id=${encodeURIComponent(input.callId)}`;
  const statusUrl = `${base}/api/twilio/status?call_id=${encodeURIComponent(input.callId)}`;

  const body = new URLSearchParams({
    From: input.from,
    To: input.to,
    Url: twimlUrl,
    Method: "POST",
    StatusCallback: statusUrl,
    StatusCallbackMethod: "POST",
    // Twilio status callback events — fire on every transition so the
    // /calls page can show a call moving through Queued → Ringing →
    // In progress → Completed in near-real-time.
    StatusCallbackEvent: "initiated ringing answered completed",
    // Machine detection — Twilio listens for an answering-machine
    // greeting and short-circuits the call so the agent doesn't talk
    // to voicemail. Result is sent back via the status webhook.
    MachineDetection: "DetectMessageEnd",
    MachineDetectionTimeout: String(
      Math.max(2000, Math.min(30000, input.amdTimeoutMs ?? 8000)),
    ),
  });

  try {
    const res = await fetch(`${TWILIO_API}/${auth.account}/Calls.json`, {
      method: "POST",
      headers: {
        Authorization: auth.header,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!res.ok) {
      let detail = "";
      try {
        const j = (await res.json()) as { message?: string; code?: number };
        detail = j.message ? ` (${j.message})` : "";
      } catch {
        // best-effort detail extraction; don't hide the call failure
        // just because Twilio returned non-JSON.
      }
      return {
        ok: false,
        error: `Twilio call create failed (${res.status})${detail}.`,
      };
    }
    const j = (await res.json()) as { sid?: string };
    if (!j.sid) {
      return { ok: false, error: "Twilio response missing CallSid." };
    }
    return { ok: true, twilioCallSid: j.sid };
  } catch {
    return { ok: false, error: "Twilio call create failed." };
  }
}
