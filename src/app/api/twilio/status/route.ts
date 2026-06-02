import { NextResponse, type NextRequest } from "next/server";

import { appBaseUrl } from "@/lib/app-url";
import {
  isValidTwilioSignature,
  processTwilioStatus,
  type TwilioCallStatus,
} from "@/lib/twilio/status-webhook";

/**
 * Twilio status callback receiver.
 *
 * Twilio POSTs `application/x-www-form-urlencoded` with `CallSid`,
 * `CallStatus`, and a pile of other fields. We:
 *   1. Validate `X-Twilio-Signature` when running in live mode (skipped in
 *      mock mode so tests can synthesize events freely).
 *   2. Insert into `twilio_status_events` for idempotency — duplicates
 *      return 200 without touching the call row.
 *   3. Map Twilio's CallStatus onto our `calls.status` and stamp the
 *      relevant timestamps.
 *
 * Always returns 2xx unless something is genuinely broken (signature, bad
 * payload). Twilio retries on non-2xx, and the only way to stop a retry
 * storm for a problem we can't fix is to accept and log.
 */
export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") params[key] = value;
  }

  const signature = request.headers.get("x-twilio-signature");
  // Reconstruct the URL Twilio signed. CRITICAL: it must include the query
  // string (`?call_id=…`) — Twilio signs the FULL StatusCallback URL it was
  // given, and omitting the query makes every signature fail (→ 403 → the
  // call row is never updated and the lead shows "On call" forever). We also
  // try the configured public base URL in case a proxy rewrites the request
  // origin (scheme/host) away from what we registered with Twilio. Tests
  // bypass validation via TWILIO_LIVE != "live".
  const pathWithQuery = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  const base = appBaseUrl();
  const candidateUrls = [
    `${request.nextUrl.origin}${pathWithQuery}`,
    base ? `${base}${pathWithQuery}` : null,
  ].filter((u): u is string => Boolean(u));
  const signatureOk = candidateUrls.some((url) =>
    isValidTwilioSignature({ url, params, signature }),
  );
  if (!signatureOk) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }

  const callSid = params.CallSid ?? "";
  const callStatus = (params.CallStatus ?? "") as TwilioCallStatus;
  if (!callSid || !callStatus) {
    return NextResponse.json(
      { error: "Missing CallSid or CallStatus" },
      { status: 400 },
    );
  }

  const result = await processTwilioStatus({
    callSid,
    callStatus,
    rawPayload: params,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 500 });
  }
  return NextResponse.json({ status: result.status });
}
