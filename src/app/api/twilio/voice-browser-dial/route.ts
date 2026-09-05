import { type NextRequest } from "next/server";

import { appBaseUrl } from "@/lib/app-url";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  buildDialTwiml,
  createHumanCallRow,
  loadHumanCallLead,
  resolveHumanCallTarget,
} from "@/lib/twilio/human-call";
import {
  authorizeHumanDial,
  parseClientIdentity,
  type HumanDialRefusal,
} from "@/lib/twilio/human-call-policy";
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

/** What the caller hears when the dial is refused, per policy reason. */
const REFUSAL_MESSAGES: Record<HumanDialRefusal, string> = {
  identity_mismatch: "This call could not be verified.",
  unknown_user: "Your account could not be found.",
  inactive_user: "Your account has been deactivated.",
  not_lead_owner: "You can only call your own leads.",
};

const DNC_MESSAGE = "This number is on the do not call list.";

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

  // The signature only proves Twilio relayed this POST — leadId / userId are
  // whatever the browser put in device.connect(). The one field Twilio itself
  // sets is From=client:<identity>, where identity is the user id our
  // voice-token route minted into the access token. THAT is who is calling.
  const callerUserId = parseClientIdentity(params.From);
  if (!callerUserId) {
    return twimlSay(REFUSAL_MESSAGES.identity_mismatch);
  }

  // Which of the lead's numbers to dial. The browser passes target=owner from
  // the lead-detail owner call control; anything else is the business line.
  const dialTarget = params.target === "owner" ? "owner" : "business";

  const supabase = createAdminClient();
  const [{ data: caller }, lead] = await Promise.all([
    supabase
      .from("profiles")
      .select("role, active")
      .eq("id", callerUserId)
      .maybeSingle(),
    loadHumanCallLead(supabase, leadId),
  ]);
  if (!lead) {
    return twimlSay("This lead could not be found.");
  }

  // Members may only dial their own leads; admins any. A deactivated account
  // is refused even while its session token is still unexpired.
  const decision = authorizeHumanDial({
    callerUserId,
    claimedUserId: userId,
    caller: caller ?? null,
    leadOwnerId: lead.owner_id,
  });
  if (!decision.ok) {
    return twimlSay(REFUSAL_MESSAGES[decision.reason]);
  }

  // A lead already moved to the DNC stage is never dialed, whichever number
  // the browser asked for.
  if (lead.status === "dnc") {
    return twimlSay(DNC_MESSAGE);
  }

  const target = await resolveHumanCallTarget(supabase, lead, dialTarget, {
    userId: callerUserId,
    isAdmin: decision.isAdmin,
  });
  if (!target) {
    return twimlSay(
      "This lead has no phone number, or no active campaign of yours has a number free to call from.",
    );
  }

  // Honour the DNC list for whichever number is about to ring — the business
  // line as much as an owner's personal cell. This used to screen only owner
  // calls, so a business number on the list could still be hand-dialed.
  const { data: onDnc } = await supabase.rpc("is_phone_on_dnc", {
    phone_to_check: target.leadPhone,
  });
  if (onDnc) {
    return twimlSay(DNC_MESSAGE);
  }

  // Twilio includes the parent call leg's SID on this POST. Stamp it on the
  // row so the Dial-completion and recording callbacks (which carry the SAME
  // CallSid) correlate by it instead of "most recent human call".
  const callSid = params.CallSid ?? null;

  await createHumanCallRow(supabase, {
    leadId,
    campaignId: target.campaignId,
    twilioNumberId: target.twilioNumberId,
    placedBy: callerUserId,
    callSid,
    dialedTarget: target.dialedTarget,
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
