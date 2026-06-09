import { type NextRequest } from "next/server";

import { appBaseUrl } from "@/lib/app-url";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidTwilioSignature } from "@/lib/twilio/status-webhook";
import {
  transcribeAudioUrl,
  summarizeTranscript,
} from "@/lib/openai/transcribe";
import type { Database } from "@/lib/supabase/database.types";

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") params[key] = value;
  }

  // Validate Twilio signature before doing anything — this is a public webhook.
  // Tests bypass via TWILIO_LIVE != "live".
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

  const recordingUrl = String(params.RecordingUrl ?? "");
  const recordingDuration = Number(params.RecordingDuration ?? "0");
  if (!recordingUrl) return new Response("", { status: 204 });

  const supabase = createAdminClient();

  // Most recent human call (the one this recording belongs to).
  const { data: call } = await supabase
    .from("calls")
    .select("id, lead_id")
    .eq("call_mode", "human")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!call) return new Response("", { status: 204 });

  const transcript = await transcribeAudioUrl(recordingUrl);
  const summary = transcript ? await summarizeTranscript(transcript) : null;

  const minutes = Math.max(0, recordingDuration) / 60;
  const cost = Number((minutes * 0.027).toFixed(4));

  const costBreakdown = {
    twilio: Number((minutes * 0.0185).toFixed(4)),
    elevenlabs: 0,
    openai: Number((minutes * 0.006 + 0.001).toFixed(4)),
    lookup: 0,
    total: cost,
  };

  await supabase
    .from("calls")
    .update({
      recording_path: recordingUrl,
      transcript_json: (transcript
        ? { text: transcript }
        : null) as Database["public"]["Tables"]["calls"]["Update"]["transcript_json"],
      summary,
      duration_seconds: recordingDuration || null,
      status: "completed",
      ended_at: new Date().toISOString(),
      cost_breakdown:
        costBreakdown as unknown as Database["public"]["Tables"]["calls"]["Update"]["cost_breakdown"],
    })
    .eq("id", call.id);

  return new Response("", { status: 204 });
}
