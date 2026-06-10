import { type NextRequest } from "next/server";

import { appBaseUrl } from "@/lib/app-url";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  buildDialTwiml,
  createHumanCallRow,
  resolveHumanCallTarget,
} from "@/lib/twilio/human-call";
import { isValidTwilioSignature } from "@/lib/twilio/status-webhook";

function twimlSay(message: string): Response {
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Say voice="Polly.Joanna">${message}</Say><Hangup/></Response>`;
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") params[key] = value;
  }

  // This is the TwiML App's Voice URL — Twilio POSTs here when the browser
  // connects. Validate the Twilio signature (same HMAC the inbound webhook
  // uses) BEFORE resolving the lead or inserting any row: otherwise the route
  // is an unauthenticated oracle that would leak the lead's phone number in the
  // returned <Dial> TwiML and create spurious call rows. Tests bypass via
  // TWILIO_LIVE != "live".
  const signature = request.headers.get("x-twilio-signature");
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
    return new Response("Forbidden", { status: 403 });
  }

  const leadId = params.leadId ?? "";
  const userId = params.userId ?? "";
  if (!leadId || !userId) {
    return twimlSay("Missing call details.");
  }

  const supabase = createAdminClient();
  const target = await resolveHumanCallTarget(supabase, leadId);
  if (!target) {
    return twimlSay(
      "This lead has no phone number or active campaign to call from.",
    );
  }

  // Twilio includes the parent call leg's SID on this POST. Stamp it on the
  // row so the Dial-completion and recording callbacks (which carry the SAME
  // CallSid) correlate by it instead of "most recent human call".
  const callSid = params.CallSid ?? null;

  await createHumanCallRow(supabase, {
    leadId,
    campaignId: target.campaignId,
    twilioNumberId: target.twilioNumberId,
    placedBy: userId,
    callSid,
  });

  const xml = buildDialTwiml({
    leadPhone: target.leadPhone,
    callerId: target.callerId,
    appBaseUrl: appBaseUrl() ?? request.nextUrl.origin,
  });
  return new Response(xml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
