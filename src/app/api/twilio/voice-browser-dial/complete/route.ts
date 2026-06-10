import { type NextRequest } from "next/server";

import { appBaseUrl } from "@/lib/app-url";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidTwilioSignature } from "@/lib/twilio/status-webhook";

/** Empty TwiML — once the dial finished there's nothing more for Twilio to do
 *  on the parent call leg, so hang it up cleanly. */
function emptyTwiml(): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`,
    { status: 200, headers: { "Content-Type": "text/xml" } },
  );
}

/**
 * Dial-completion callback for human browser calls. Twilio POSTs here when the
 * <Dial> in buildDialTwiml finishes for ANY reason — answered, no-answer, busy,
 * failed — carrying DialCallStatus + DialCallDuration. This is what terminalizes
 * EVERY human call: the recording callback only fires when the lead answered, so
 * without this an unanswered call would sit in 'dialing' until the stale reaper
 * (15 min) flipped it. Here we mark it 'completed' with its end time/duration.
 *
 * We do NOT set `outcome` — a human dispositions the call by hand (even a
 * no-answer call gets a disposition), and that's the only thing that should
 * write the outcome.
 */
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") params[key] = value;
  }

  // Validate the Twilio signature before doing anything — this is a public
  // webhook. Validate against both the request origin and the configured
  // public base URL (a proxy may rewrite scheme/host away from the URL Twilio
  // signed). Tests bypass via TWILIO_LIVE != "live".
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

  const callSid = String(params.CallSid ?? "");
  const dialCallDuration = Number(params.DialCallDuration ?? "0");

  const supabase = createAdminClient();

  // Correlate by the parent CallSid stamped at creation. Fall back to the
  // most-recent human call still in a non-terminal status if the SID didn't
  // round-trip (e.g. a row created before this column was wired).
  let call: { id: string; duration_seconds: number | null } | null = null;
  if (callSid) {
    const { data } = await supabase
      .from("calls")
      .select("id, duration_seconds")
      .eq("twilio_call_sid", callSid)
      .eq("call_mode", "human")
      .maybeSingle();
    call = data ?? null;
  }
  if (!call) {
    // Non-terminal = still in one of the in-flight statuses (the same set the
    // stale reaper treats as "active"). completed/failed are the only terminal
    // statuses this app writes.
    const { data } = await supabase
      .from("calls")
      .select("id, duration_seconds")
      .eq("call_mode", "human")
      .in("status", ["queued", "dialing", "ringing", "in_progress"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    call = data ?? null;
  }
  if (!call) return emptyTwiml();

  const update: {
    status: string;
    ended_at: string;
    duration_seconds?: number;
  } = {
    status: "completed",
    ended_at: new Date().toISOString(),
  };
  // Only set duration when Twilio reported a positive value and the row
  // doesn't already have one (the recording callback may have set it first).
  if (dialCallDuration > 0 && (call.duration_seconds ?? 0) <= 0) {
    update.duration_seconds = dialCallDuration;
  }

  await supabase.from("calls").update(update).eq("id", call.id);

  return emptyTwiml();
}
