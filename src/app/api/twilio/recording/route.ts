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

  const callSid = String(params.CallSid ?? "");

  const supabase = createAdminClient();

  // Correlate by the parent CallSid (the recording callback carries the SAME
  // CallSid the dial route stamped). Fall back to the most-recent human call if
  // the SID didn't round-trip. Read the existing summary/status/duration so we
  // can MERGE rather than clobber a human's saved disposition note.
  let call: {
    id: string;
    summary: string | null;
    status: string;
    duration_seconds: number | null;
  } | null = null;
  if (callSid) {
    const { data } = await supabase
      .from("calls")
      .select("id, summary, status, duration_seconds")
      .eq("twilio_call_sid", callSid)
      .eq("call_mode", "human")
      .maybeSingle();
    call = data ?? null;
  }
  if (!call) {
    const { data } = await supabase
      .from("calls")
      .select("id, summary, status, duration_seconds")
      .eq("call_mode", "human")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    call = data ?? null;
  }
  if (!call) return new Response("", { status: 204 });

  const transcript = await transcribeAudioUrl(recordingUrl);
  const aiSummary = transcript ? await summarizeTranscript(transcript) : null;

  const minutes = Math.max(0, recordingDuration) / 60;
  const cost = Number((minutes * 0.027).toFixed(4));

  const costBreakdown = {
    twilio: Number((minutes * 0.0185).toFixed(4)),
    elevenlabs: 0,
    openai: Number((minutes * 0.006 + 0.001).toFixed(4)),
    lookup: 0,
    total: cost,
  };

  // Merge the summary: never clobber a human's disposition note. If the user
  // already saved a note, append the AI summary below it; if there's no note
  // yet, use the AI summary. If transcription failed (aiSummary null), leave
  // whatever's there untouched — never write null over an existing value.
  const existingSummary = call.summary?.trim() ? call.summary : null;
  let summary: string | undefined;
  if (existingSummary && aiSummary) {
    summary = `${existingSummary}\n\nAI summary: ${aiSummary}`;
  } else if (existingSummary) {
    summary = existingSummary;
  } else if (aiSummary) {
    summary = aiSummary;
  } else {
    summary = undefined; // omit from update — don't overwrite with null
  }

  const update: Database["public"]["Tables"]["calls"]["Update"] = {
    recording_path: recordingUrl,
    cost_breakdown:
      costBreakdown as unknown as Database["public"]["Tables"]["calls"]["Update"]["cost_breakdown"],
  };
  // Only write a transcript when we actually have one — a null/failed
  // transcription must not erase a previously-stored transcript.
  if (transcript) {
    update.transcript_json = {
      text: transcript,
    } as Database["public"]["Tables"]["calls"]["Update"]["transcript_json"];
  }
  if (summary !== undefined) update.summary = summary;
  // Only set duration when Twilio reported one and the row doesn't already
  // have a value (the Dial-completion callback may have set it first).
  if (recordingDuration > 0 && (call.duration_seconds ?? 0) <= 0) {
    update.duration_seconds = recordingDuration;
  }
  // Don't downgrade a call that's already terminal. If it isn't terminal yet,
  // complete it with an end time.
  if (call.status !== "completed") {
    update.status = "completed";
    update.ended_at = new Date().toISOString();
  }

  await supabase.from("calls").update(update).eq("id", call.id);

  return new Response("", { status: 204 });
}
