import "server-only";

import { createClient } from "@supabase/supabase-js";

import { buildCallDynamicVariables } from "@/lib/elevenlabs/conversation-init";
import type { Database } from "@/lib/supabase/database.types";
import {
  ensureNumberImportedToElevenLabs,
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
  // Register the number with ElevenLabs (cached after the first import). Shared
  // helper so the dialer, campaign-attach, and the manual Sync button all
  // register a number identically.
  const imported = await ensureNumberImportedToElevenLabs(
    supabase,
    input.twilioNumberId,
  );
  if (!imported.ok) return { ok: false, error: imported.error };
  const phoneNumberId = imported.phoneNumberId;

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
