import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import {
  assignInboundAgentToElevenLabsNumber,
  importTwilioNumberToElevenLabs,
} from "@/lib/twilio/place-call";

type SupabaseAdmin = ReturnType<typeof createClient<Database>>;

/** The voice webhook ElevenLabs sets on a Twilio number once it manages it
 *  natively. We mirror it onto twilio_numbers.voice_webhook_url after wiring
 *  inbound so the Twilio Numbers page shows the number as EL-managed (and an
 *  admin isn't tempted to "Repoint webhooks" back at the app — which is what
 *  historically re-broke inbound). EL-managed; informational only. */
const ELEVENLABS_INBOUND_VOICE_URL =
  "https://api.elevenlabs.io/twilio/inbound_call";

function makeServiceClient(): SupabaseAdmin {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    throw new Error(
      "Inbound config requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export type ConfigureInboundResult =
  | { ok: true; phoneNumberId: string }
  | { ok: false; error: string };

/**
 * Wire a Twilio number for INBOUND so callers reach the campaign's agent.
 *
 * ElevenLabs answers inbound natively (the same path outbound uses); the old
 * app-mediated `<Connect><Stream>` bridge never connected a real conversation.
 * So we: (1) import the number into the EL workspace if we haven't already
 * (caching elevenlabs_phone_number_id, shared with outbound), and (2) assign the
 * campaign's agent as the number's inbound agent. EL then takes over the number's
 * Twilio voice webhook — expected, so we mirror that onto our stored
 * voice_webhook_url to keep the admin page honest.
 *
 * Runs under the service role (independent of the caller's RLS) and is
 * best-effort: callers (campaign create/update) ignore failures so a campaign
 * save never blocks on an ElevenLabs hiccup. Off-live everything is mocked.
 */
export async function configureNumberInbound(input: {
  twilioNumberId: string;
  /** Local agents.id of the campaign's agent. */
  agentLocalId: string | null | undefined;
}): Promise<ConfigureInboundResult> {
  if (!input.agentLocalId) {
    return { ok: false, error: "Campaign has no agent to answer inbound." };
  }
  const supabase = makeServiceClient();

  const { data: agent } = await supabase
    .from("agents")
    .select("elevenlabs_agent_id")
    .eq("id", input.agentLocalId)
    .maybeSingle();
  if (!agent?.elevenlabs_agent_id) {
    return { ok: false, error: "Agent isn't published to ElevenLabs yet." };
  }

  const { data: num } = await supabase
    .from("twilio_numbers")
    .select(
      "phone_number, friendly_name, twilio_sid, released_at, elevenlabs_phone_number_id",
    )
    .eq("id", input.twilioNumberId)
    .maybeSingle();
  if (!num || num.released_at) {
    return { ok: false, error: "Twilio number isn't available." };
  }

  // Import into EL on first use, caching the id (the SAME id outbound dialing
  // caches/uses), so a number imported by either path is reused by the other.
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

  const assigned = await assignInboundAgentToElevenLabsNumber({
    phoneNumberId,
    elevenlabsAgentId: agent.elevenlabs_agent_id,
  });
  if (!assigned.ok) return { ok: false, error: assigned.error };

  // EL now owns the number's inbound voice webhook — reflect that in our record
  // so the admin page shows "EL-managed" instead of flagging drift / nudging a
  // repoint that would re-break inbound.
  await supabase
    .from("twilio_numbers")
    .update({ voice_webhook_url: ELEVENLABS_INBOUND_VOICE_URL })
    .eq("id", input.twilioNumberId);

  return { ok: true, phoneNumberId };
}
