import "server-only";

import { createClient } from "@supabase/supabase-js";

import { buildBridgeTwiml } from "@/lib/elevenlabs/twilio-stream";
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
 * TwiML that hands the call to ElevenLabs Conversational AI.
 *
 * Round L4 — live mode now actually bridges: it mints a single-use
 * ElevenLabs Convai signed URL for the agent and returns
 * `<Connect><Stream>` TwiML so Twilio relays the call's audio
 * straight to ElevenLabs. If the signed-URL fetch fails (network
 * blip, expired/revoked agent, key missing) we fall back to the
 * mock placeholder so the call doesn't drop with a parse error.
 *
 * In mock mode (default) we return a `<Say>` placeholder so tests
 * can assert on call_id / lead_id being passed through. Both the
 * Playwright suite and inbound webhook tests rely on this body
 * containing those ids.
 */
export async function connectToAgentTwiml(input: {
  elevenLabsAgentId: string;
  callId: string;
  leadId: string;
  aiSummary: string | null;
}): Promise<string> {
  if (process.env.ELEVENLABS_LIVE === "live") {
    const bridge = await buildBridgeTwiml({
      elevenlabsAgentId: input.elevenLabsAgentId,
      // Attach our call_id as a Stream <Parameter> so ElevenLabs echoes it
      // back in the post-call webhook — without it, the webhook can't link the
      // conversation to this inbound calls row and the recording/transcript/
      // summary/outcome never attach.
      callId: input.callId,
    });
    if (bridge) return bridge;
    // Fall through to the placeholder so the inbound call still
    // hears something rather than a Twilio "couldn't parse TwiML"
    // error. The system_events row written by the route handler
    // surfaces the silent fall-back to ops.
  }
  // Mock mode (or live-mode fall-back): echo back a friendly
  // placeholder. Tests assert on the call_id and lead_id being
  // passed through so a real bridge can drop in.
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

export type EnsureInboundResult =
  | {
      status: "routed";
      callId: string;
      leadId: string;
      campaignId: string;
      /** Local agents.id of the campaign's agent (may be null). */
      agentLocalId: string | null;
      /** The lead's rolling summary (null for a freshly-created lead). */
      aiSummary: string | null;
    }
  | { status: "no_service" }
  | { ok: false; reason: string };

/**
 * Find-or-create the inbound `calls` row (and its lead) for one incoming call,
 * with NO TwiML. See BUILD_PLAN §6:
 *
 *   1. Destination Twilio number → its attached campaign. No campaign → no_service.
 *   2. Caller's phone → a lead in the campaign owner's leads. Match → reuse it
 *      (preserve ai_summary); no match → create a lead in the owner's Inbound list.
 *   3. Upsert a `calls` row (direction='inbound', twilio_call_sid=CallSid). The
 *      unique constraint on twilio_call_sid is the idempotency lock, so this is
 *      safe to call more than once for the same call — e.g. from BOTH the
 *      conversation-init webhook (EL-native inbound) and a Twilio retry.
 *
 * Shared by `routeInboundCall` (legacy app-mediated voice webhook → TwiML) and
 * the conversation-init webhook (EL-native inbound), so an inbound call is
 * logged + lead-matched exactly once regardless of which path EL/Twilio use.
 */
export async function ensureInboundCallRow(
  supabase: SupabaseAdmin,
  input: { callSid: string; fromNumber: string; toNumber: string },
): Promise<EnsureInboundResult> {
  if (!input.callSid || !input.toNumber) {
    return { ok: false, reason: "missing_call_sid_or_to" };
  }

  // 1. Twilio number → campaign.
  const { data: numberRow } = await supabase
    .from("twilio_numbers")
    .select("id, attached_campaign_id")
    .eq("phone_number", input.toNumber)
    .maybeSingle();
  if (!numberRow || !numberRow.attached_campaign_id) {
    return { status: "no_service" };
  }

  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id, owner_id, agent_id")
    .eq("id", numberRow.attached_campaign_id)
    .maybeSingle();
  if (!campaign) {
    return { status: "no_service" };
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
  // our idempotency lock: a Twilio retry (or both inbound paths firing) maps to
  // a no-op upsert onto the same row.
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

  return {
    status: "routed",
    callId: call.id,
    leadId,
    campaignId: campaign.id,
    agentLocalId: campaign.agent_id,
    aiSummary,
  };
}

/**
 * Route one inbound Twilio call for the LEGACY app-mediated voice webhook
 * (`/api/twilio/voice-inbound`): resolve/insert the call via
 * `ensureInboundCallRow`, then return TwiML.
 *
 * NOTE: with EL-native inbound (the number's agent assigned in ElevenLabs),
 * Twilio delivers inbound calls to ElevenLabs directly and this route is no
 * longer hit. It stays as a fallback for any number still pointed at the app —
 * but the `<Connect><Stream>` bridge it returns never actually connected a
 * conversation (see twilio-stream.ts / place-call.ts), so EL-native is the
 * supported path.
 */
export async function routeInboundCall(input: {
  callSid: string;
  fromNumber: string;
  toNumber: string;
}): Promise<InboundResult> {
  const supabase = makeServiceClient();
  const res = await ensureInboundCallRow(supabase, input);
  if ("ok" in res) return res;
  if (res.status === "no_service") {
    return { status: "no_service", twiml: notInServiceTwiml() };
  }

  // Pull the agent's ElevenLabs ID for the TwiML response.
  const { data: agent } = await supabase
    .from("agents")
    .select("elevenlabs_agent_id")
    .eq("id", res.agentLocalId ?? "")
    .maybeSingle();
  const elevenLabsAgentId = agent?.elevenlabs_agent_id ?? "unknown";

  const twiml = await connectToAgentTwiml({
    elevenLabsAgentId,
    callId: res.callId,
    leadId: res.leadId,
    aiSummary: res.aiSummary,
  });
  return { status: "routed", callId: res.callId, leadId: res.leadId, twiml };
}
