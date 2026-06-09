import { type NextRequest } from "next/server";

import { appBaseUrl } from "@/lib/app-url";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  buildDialTwiml,
  createHumanCallRow,
  resolveHumanCallTarget,
} from "@/lib/twilio/human-call";

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
  const leadId = String(form.get("leadId") ?? "");
  const userId = String(form.get("userId") ?? "");
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

  await createHumanCallRow(supabase, {
    leadId,
    campaignId: target.campaignId,
    twilioNumberId: target.twilioNumberId,
    placedBy: userId,
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
