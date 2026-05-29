import { NextResponse } from "next/server";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

/** Round L3 — outbound TwiML responder.
 *
 *  Twilio fetches this URL after the callee answers an outbound call
 *  and follows whatever instructions we return as TwiML. For L3 we
 *  return a simple `<Say>` so we can prove the dial → connect →
 *  status pipeline works end-to-end without ElevenLabs in the loop.
 *  L4 swaps the `<Say>` for `<Connect><Stream>` against an ElevenLabs
 *  agent.
 *
 *  We accept both GET and POST because Twilio's HTTP method preference
 *  drifts between accounts and we already told it `POST` when placing
 *  the call. The query string carries `call_id` so we can look up the
 *  matching `calls` row (mostly for future use — currently we don't
 *  need it for the placeholder TwiML). */

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

async function buildResponse(callId: string | null): Promise<string> {
  // For L3 we don't actually need to read the call row, but we still
  // want a recorded "Twilio asked us for TwiML" event in system_events
  // so the operator can see the lifecycle on /system-health. Best-
  // effort — if the insert fails we still hand Twilio a valid TwiML
  // string so the call doesn't drop.
  try {
    const supabase = makeServiceClient();
    await supabase.from("system_events").insert({
      kind: "twilio_voice_outbound_twiml_served",
      actor_user_id: null,
      ref_table: "calls",
      ref_id: callId ?? null,
      payload: { call_id: callId },
    });
  } catch {
    // logging failure is not a reason to break the call
  }

  return TWIML_PLACEHOLDER;
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
  return POST(request);
}
