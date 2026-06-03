import "server-only";

import { createClient } from "@supabase/supabase-js";

import { buildCallDynamicVariables } from "@/lib/elevenlabs/conversation-init";
import type { Database } from "@/lib/supabase/database.types";
import {
  importTwilioNumberToElevenLabs,
  placeAgentCall,
  type PlaceCallResult,
} from "@/lib/twilio/place-call";

type SupabaseAdmin = ReturnType<typeof createClient<Database>>;

/**
 * Resolve everything ElevenLabs needs to place a native Twilio call, then place
 * it. Shared by Call Now and the autopilot dialer tick so the resolution logic
 * (agent → elevenlabs_agent_id, Twilio number → imported phone_number_id,
 * importing on first use) lives in exactly one place.
 */
export async function resolveAndPlaceAgentCall(
  supabase: SupabaseAdmin,
  input: {
    callId: string;
    agentId: string | null;
    twilioNumberId: string | null;
    toNumber: string;
    dynamicVariables?: Record<string, string | number | boolean | null>;
  },
): Promise<PlaceCallResult> {
  if (!input.agentId) {
    return { ok: false, error: "Campaign has no agent assigned." };
  }
  const { data: agent } = await supabase
    .from("agents")
    .select("elevenlabs_agent_id")
    .eq("id", input.agentId)
    .maybeSingle();
  if (!agent?.elevenlabs_agent_id) {
    return {
      ok: false,
      error: "The campaign's agent isn't published to ElevenLabs yet.",
    };
  }

  if (!input.twilioNumberId) {
    return { ok: false, error: "Campaign has no Twilio number assigned." };
  }
  const { data: num } = await supabase
    .from("twilio_numbers")
    .select(
      "phone_number, friendly_name, released_at, elevenlabs_phone_number_id",
    )
    .eq("id", input.twilioNumberId)
    .maybeSingle();
  if (!num || num.released_at) {
    return {
      ok: false,
      error: "The campaign's Twilio number isn't available.",
    };
  }

  // Import the number into ElevenLabs the first time we dial from it, then
  // cache the id so we only import once.
  let phoneNumberId = num.elevenlabs_phone_number_id;
  if (!phoneNumberId) {
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    if (!twilioSid || !twilioToken) {
      return { ok: false, error: "Twilio credentials are not configured." };
    }
    const imported = await importTwilioNumberToElevenLabs({
      phoneNumber: num.phone_number,
      label: num.friendly_name
        ? `${num.friendly_name} (Smile & Dial)`
        : `Smile & Dial ${num.phone_number}`,
      twilioSid,
      twilioToken,
    });
    if (!imported.ok) return { ok: false, error: imported.error };
    phoneNumberId = imported.phoneNumberId;
    await supabase
      .from("twilio_numbers")
      .update({ elevenlabs_phone_number_id: phoneNumberId })
      .eq("id", input.twilioNumberId);
  }

  // Build the agent's personalization variables (lead name, city, call_type,
  // last-call summary, transfer number, …). ElevenLabs does NOT call our
  // conversation-init webhook for API-placed outbound calls, so we MUST pass
  // these here or the agent runs with blank placeholders. Caller-supplied
  // overrides win.
  const leadVars = await buildCallDynamicVariables(supabase, input.callId);

  return placeAgentCall({
    callId: input.callId,
    toNumber: input.toNumber,
    elevenlabsAgentId: agent.elevenlabs_agent_id,
    elevenlabsPhoneNumberId: phoneNumberId,
    dynamicVariables: { ...leadVars, ...(input.dynamicVariables ?? {}) },
  });
}
