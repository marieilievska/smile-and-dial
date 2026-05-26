import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

type SupabaseAdmin = ReturnType<typeof createClient<Database>>;

function makeServiceClient(): SupabaseAdmin {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    throw new Error(
      "Inbound webhook requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** XML-escape a string for embedding in TwiML. */
function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** TwiML for "this number is not in service." */
export function notInServiceTwiml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Say voice="Polly.Joanna">This number is not in service.</Say>` +
    `<Hangup/>` +
    `</Response>`
  );
}

/**
 * TwiML that hands the call to ElevenLabs Conversational AI. In live mode
 * we'd return a `<Connect><Stream>` pointing at ElevenLabs's media stream
 * endpoint. In mock mode (default) we return a `<Say>` placeholder so the
 * call doesn't drop and tests can assert on the response body.
 */
export function connectToAgentTwiml(input: {
  elevenLabsAgentId: string;
  callId: string;
  leadId: string;
  aiSummary: string | null;
}): string {
  if (process.env.ELEVENLABS_LIVE === "live") {
    // Real Connect → Stream wiring against ElevenLabs Conversational AI
    // belongs here. Deferred until live ElevenLabs is approved.
    return (
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response>` +
      `<Say voice="Polly.Joanna">` +
      `Live ElevenLabs integration is not implemented yet.` +
      `</Say>` +
      `<Hangup/>` +
      `</Response>`
    );
  }
  // Mock mode: echo back a friendly placeholder. Tests assert on the
  // call_id and lead_id being passed through so a real bridge can drop in.
  const note = input.aiSummary
    ? `Previous summary: ${input.aiSummary}`
    : "No prior summary on file.";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Say voice="Polly.Joanna">${xml(
      `Connecting you to agent ${input.elevenLabsAgentId}. ${note}`,
    )}</Say>` +
    `<Hangup/>` +
    `</Response>`
  );
}

export type InboundResult =
  | { status: "routed"; callId: string; leadId: string; twiml: string }
  | { status: "no_service"; twiml: string }
  | { status: "duplicate"; callId: string; twiml: string }
  | { ok: false; reason: string };

/**
 * Route one inbound Twilio call. See BUILD_PLAN §6.
 *
 *   1. Look up which campaign owns the destination Twilio number.
 *      No campaign → "not in service".
 *   2. Look up the caller's phone in that owner's leads.
 *      Match → reuse the lead, preserve ai_summary.
 *      No match → create a new lead in the owner's Inbound list.
 *   3. Insert a `calls` row with direction='inbound', twilio_call_sid=
 *      Twilio's CallSid. Unique constraint on twilio_call_sid gives us
 *      idempotency for free.
 *   4. Return TwiML that connects the audio to the campaign's agent.
 */
export async function routeInboundCall(input: {
  callSid: string;
  fromNumber: string;
  toNumber: string;
}): Promise<InboundResult> {
  if (!input.callSid || !input.toNumber) {
    return { ok: false, reason: "missing_call_sid_or_to" };
  }

  const supabase = makeServiceClient();

  // 1. Twilio number → campaign.
  const { data: numberRow } = await supabase
    .from("twilio_numbers")
    .select("id, attached_campaign_id")
    .eq("phone_number", input.toNumber)
    .maybeSingle();
  if (!numberRow || !numberRow.attached_campaign_id) {
    return { status: "no_service", twiml: notInServiceTwiml() };
  }

  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id, owner_id, agent_id")
    .eq("id", numberRow.attached_campaign_id)
    .maybeSingle();
  if (!campaign) {
    return { status: "no_service", twiml: notInServiceTwiml() };
  }

  // 2. Caller phone → lead (within campaign owner's leads).
  let leadId: string;
  let aiSummary: string | null = null;
  const { data: existingLead } = await supabase
    .from("leads")
    .select("id, ai_summary")
    .eq("owner_id", campaign.owner_id)
    .eq("business_phone", input.fromNumber)
    .maybeSingle();
  if (existingLead) {
    leadId = existingLead.id;
    aiSummary = existingLead.ai_summary;
  } else {
    const { data: listId } = await supabase.rpc("get_or_create_inbound_list", {
      in_owner: campaign.owner_id,
    });
    if (!listId) return { ok: false, reason: "could_not_get_inbound_list" };

    const { data: newLead, error: newLeadError } = await supabase
      .from("leads")
      .insert({
        owner_id: campaign.owner_id,
        list_id: listId as string,
        business_phone: input.fromNumber,
        company: input.fromNumber, // Will get auto-filled from extracted_data later.
      })
      .select("id")
      .single();
    if (newLeadError || !newLead) {
      return { ok: false, reason: "could_not_create_lead" };
    }
    leadId = newLead.id;
  }

  // 3. Insert the call row. The unique constraint on twilio_call_sid is
  // our idempotency lock: a Twilio retry maps to a no-op upsert.
  const { data: call, error: callError } = await supabase
    .from("calls")
    .upsert(
      {
        lead_id: leadId,
        campaign_id: campaign.id,
        agent_id: campaign.agent_id,
        twilio_number_id: numberRow.id,
        direction: "inbound",
        status: "in_progress",
        twilio_call_sid: input.callSid,
        started_at: new Date().toISOString(),
      },
      { onConflict: "twilio_call_sid" },
    )
    .select("id")
    .single();
  if (callError || !call) {
    return { ok: false, reason: "could_not_insert_call" };
  }

  // 4. Pull the agent's ElevenLabs ID for the TwiML response.
  const { data: agent } = await supabase
    .from("agents")
    .select("elevenlabs_agent_id")
    .eq("id", campaign.agent_id)
    .maybeSingle();
  const elevenLabsAgentId = agent?.elevenlabs_agent_id ?? "unknown";

  const twiml = connectToAgentTwiml({
    elevenLabsAgentId,
    callId: call.id,
    leadId,
    aiSummary,
  });
  return { status: "routed", callId: call.id, leadId, twiml };
}
