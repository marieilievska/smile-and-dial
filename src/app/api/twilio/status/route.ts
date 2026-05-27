import { NextResponse, type NextRequest } from "next/server";

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
  // Reconstruct the URL Twilio signed: scheme + host + path. Tests bypass
  // signature validation via TWILIO_LIVE != "live".
  const url = `${request.nextUrl.origin}${request.nextUrl.pathname}`;
  if (!isValidTwilioSignature({ url, params, signature })) {
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
