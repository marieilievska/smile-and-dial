import { NextResponse } from "next/server";

import { createClient } from "@supabase/supabase-js";

import { buildBridgeTwiml } from "@/lib/elevenlabs/twilio-stream";
import type { Database } from "@/lib/supabase/database.types";

/** Outbound TwiML responder. Twilio fetches this URL after the callee
 *  answers an outbound call and follows whatever instructions we
 *  return as TwiML.
 *
 *  Round L3 — returned a static `<Say>` test message so the dial →
 *  connect → status pipeline could be proved end-to-end without
 *  ElevenLabs.
 *  Round L4 — looks up the call's agent, mints a single-use
 *  ElevenLabs Convai signed URL, and returns `<Connect><Stream/>`
 *  TwiML that bridges the Twilio audio to that URL. If anything
 *  in that path fails (no agent on the call, no ElevenLabs id on
 *  the agent, signed-URL request fails, or ELEVENLABS_LIVE isn't
 *  set), we fall back to the L3 placeholder TwiML so the call
 *  doesn't drop with a parse error.
 *
 *  We accept GET and POST because Twilio's HTTP method preference
 *  drifts between accounts. The query string carries `call_id` so
 *  the handler can resolve the matching `calls` row to find the
 *  agent. */

type SupabaseAdmin = ReturnType<typeof createClient<Database>>;

function makeServiceClient(): SupabaseAdmin {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    throw new Error(
      "Voice-outbound webhook requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const TWIML_PLACEHOLDER = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">
    Hello, this is a Smile and Dial test call. The agent will be wired up next. Goodbye.
  </Say>
  <Hangup/>
</Response>`;

/** Resolve the ElevenLabs agent id from the call row. Returns null
 *  on any error or missing piece so the caller falls back cleanly to
 *  the placeholder TwiML. */
async function resolveAgentId(
  supabase: SupabaseAdmin,
  callId: string | null,
): Promise<string | null> {
  if (!callId) return null;
  const { data: call } = await supabase
    .from("calls")
    .select("agent_id")
    .eq("id", callId)
    .maybeSingle();
  if (!call?.agent_id) return null;
  const { data: agent } = await supabase
    .from("agents")
    .select("elevenlabs_agent_id")
    .eq("id", call.agent_id)
    .maybeSingle();
  return agent?.elevenlabs_agent_id ?? null;
}

async function buildResponse(callId: string | null): Promise<string> {
  const supabase = makeServiceClient();

  // We bridge EVERY answered call to the agent — no Twilio machine detection
  // gate. If the call actually reaches a voicemail, the agent's own
  // voicemail_detection ends it; this avoids hanging up on a live person who
  // answers with a long business greeting (Twilio's AMD mislabels those).

  // Round L4 — attempt the live ElevenLabs bridge first. Falls back
  // to the placeholder TwiML on any failure so callers never hear a
  // parser error from Twilio.
  let twiml: string | null = null;
  const elevenlabsAgentId = await resolveAgentId(supabase, callId);
  if (elevenlabsAgentId) {
    twiml = await buildBridgeTwiml({ elevenlabsAgentId, callId });
  }

  // Record what we served so the operator can see the bridge picking
  // (live vs. placeholder) on /system-health. Best-effort.
  try {
    await supabase.from("system_events").insert({
      kind: "twilio_voice_outbound_twiml_served",
      actor_user_id: null,
      ref_table: "calls",
      ref_id: callId ?? null,
      payload: {
        call_id: callId,
        mode: twiml ? "elevenlabs_bridge" : "placeholder",
        elevenlabs_agent_id: elevenlabsAgentId,
      },
    });
  } catch {
    // logging failure is not a reason to break the call
  }

  return twiml ?? TWIML_PLACEHOLDER;
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const callId = url.searchParams.get("call_id");
  const twiml = await buildResponse(callId);
  return new NextResponse(twiml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const callId = url.searchParams.get("call_id");
  const twiml = await buildResponse(callId);
  return new NextResponse(twiml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
