import { NextResponse, type NextRequest } from "next/server";

import { isValidTwilioSignature } from "@/lib/twilio/status-webhook";
import { routeInboundCall } from "@/lib/twilio/inbound-webhook";

/**
 * Twilio inbound voice webhook. When a Twilio number we own receives an
 * inbound call, Twilio POSTs here (application/x-www-form-urlencoded) and
 * waits for a TwiML response telling it what to do with the call.
 *
 * Reuses the signature validator from the status webhook — same HMAC-SHA1
 * algorithm. Live mode validates; mock mode skips so tests can synthesize.
 */
export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") params[key] = value;
  }

  const signature = request.headers.get("x-twilio-signature");
  const url = `${request.nextUrl.origin}${request.nextUrl.pathname}`;
  if (!isValidTwilioSignature({ url, params, signature })) {
    return new Response("Forbidden", { status: 403 });
  }

  const result = await routeInboundCall({
    callSid: params.CallSid ?? "",
    fromNumber: params.From ?? "",
    toNumber: params.To ?? "",
  });
  if ("ok" in result) {
    // Internal error path — return 500 JSON, Twilio will surface the failure.
    return NextResponse.json({ error: result.reason }, { status: 500 });
  }

  // Always 200 with TwiML so Twilio doesn't error the call.
  return new Response(result.twiml, {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}
