import { NextResponse } from "next/server";

import { createClient } from "@supabase/supabase-js";

import { applyRetryForCall } from "@/lib/dialer/retry-engine";
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

// Hang up without bridging — used when Twilio's machine detection says we
// reached an answering machine. We don't connect the AI to a voicemail box.
const TWIML_HANGUP = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Hangup/></Response>`;

// Twilio AnsweredBy values that mean "not a live human". `human` and
// `unknown` fall through to the agent (we'd rather talk to an uncertain human
// than silently drop a real lead).
const MACHINE_ANSWERS = new Set([
  "machine_start",
  "machine_end_beep",
  "machine_end_silence",
  "machine_end_other",
  "fax",
]);

/** Record a voicemail/machine answer on the call from Twilio's detection —
 *  no audio or transcript needed, the carrier-grade AMD result is the proof.
 *  Stamps outcome=voicemail, logs the exact AnsweredBy for the audit trail,
 *  and runs the retry engine so the lead gets rescheduled like a no-answer. */
async function recordVoicemail(
  supabase: SupabaseAdmin,
  callId: string,
  answeredBy: string,
): Promise<void> {
  await supabase
    .from("calls")
    .update({
      status: "completed",
      outcome: "voicemail",
      outcome_source: "twilio",
      ended_at: new Date().toISOString(),
    })
    .eq("id", callId)
    .is("ended_at", null);

  try {
    await supabase.from("system_events").insert({
      kind: "twilio_amd_voicemail",
      actor_user_id: null,
      ref_table: "calls",
      ref_id: callId,
      payload: { call_id: callId, answered_by: answeredBy },
    });
  } catch {
    // logging failure must not break the TwiML response
  }
  try {
    await applyRetryForCall(callId);
  } catch {
    // retry scheduling is best-effort; the outcome is already stamped
  }
}

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

async function buildResponse(
  callId: string | null,
  answeredBy: string | null,
): Promise<string> {
  const supabase = makeServiceClient();

  // Voicemail / machine: never bridge the AI to a recording. Record the
  // outcome straight from Twilio's machine detection (so we KNOW it was
  // voicemail without any audio), then hang up.
  if (answeredBy && MACHINE_ANSWERS.has(answeredBy)) {
    if (callId) await recordVoicemail(supabase, callId, answeredBy);
    return TWIML_HANGUP;
  }

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
  // Twilio's machine-detection verdict arrives as the `AnsweredBy` form field
  // (synchronous AMD passes it on the TwiML request). Fall back to the query
  // string for GET.
  let answeredBy = url.searchParams.get("AnsweredBy");
  try {
    const form = await request.formData();
    const fromForm = form.get("AnsweredBy");
    if (typeof fromForm === "string") answeredBy = fromForm;
  } catch {
    // no form body (e.g. GET) — keep the query-string value
  }
  const twiml = await buildResponse(callId, answeredBy);
  return new NextResponse(twiml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const callId = url.searchParams.get("call_id");
  const answeredBy = url.searchParams.get("AnsweredBy");
  const twiml = await buildResponse(callId, answeredBy);
  return new NextResponse(twiml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
