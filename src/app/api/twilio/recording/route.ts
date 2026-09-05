import { type NextRequest } from "next/server";

import { appBaseUrl } from "@/lib/app-url";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidTwilioSignature } from "@/lib/twilio/status-webhook";
import { numField, withRecomputedTotal } from "@/lib/costs/breakdown";
import { primeEffectiveRates } from "@/lib/costs/effective-rates";
import {
  priceTwilioCall,
  priceWhisper,
  priceOpenAiTokens,
} from "@/lib/costs/rates";
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
  const recordingSid = String(params.RecordingSid ?? "");

  const supabase = createAdminClient();
  // Price at the providers' effective rates (cost_rates), never throws.
  await primeEffectiveRates(supabase);

  // Idempotency guard: Twilio delivers recording callbacks at-least-once and
  // retries on any non-2xx. Claim the recording_sid FIRST so a duplicate
  // delivery never re-runs the paid Whisper transcription + gpt-4o-mini summary
  // (and never re-writes the call's cost). Mirrors the twilio_status_events
  // guard used by the status webhook.
  if (recordingSid) {
    const { error: claimError } = await supabase
      .from("twilio_recording_events")
      .insert({ recording_sid: recordingSid, call_sid: callSid || null });
    if (claimError && (claimError as { code?: string }).code === "23505") {
      // 23505 = unique_violation → we've already processed this recording.
      return new Response("", { status: 204 });
    }
    // Any OTHER claim error (a transient DB issue, or the table not yet present
    // if this ever runs pre-migration) falls through and processes anyway: a
    // rare duplicate charge is better than silently dropping the transcript.
  }

  // Correlate STRICTLY by the parent CallSid the dial route stamped. We do NOT
  // fall back to "the most recent human call" — that could attach this
  // recording's transcript + cost to a DIFFERENT lead's call. Read the existing
  // summary/status/duration so we MERGE rather than clobber a human's saved
  // disposition note, and the direction + prior cost so the call is priced at
  // the right Twilio rate without dropping a lookup already on the row.
  let call: {
    id: string;
    summary: string | null;
    status: string;
    duration_seconds: number | null;
    direction: string | null;
    cost_breakdown: unknown;
  } | null = null;
  if (callSid) {
    const { data } = await supabase
      .from("calls")
      .select(
        "id, summary, status, duration_seconds, direction, cost_breakdown",
      )
      .eq("twilio_call_sid", callSid)
      .eq("call_mode", "human")
      .maybeSingle();
    call = data ?? null;
  }
  if (!call) {
    // No matching human call. Release the idempotency claim so a later delivery
    // can still process once the call row's SID is available, then skip.
    if (recordingSid) {
      await supabase
        .from("twilio_recording_events")
        .delete()
        .eq("recording_sid", recordingSid);
    }
    return new Response("", { status: 204 });
  }

  try {
    const transcript = await transcribeAudioUrl(recordingUrl);
    const summaryResult = transcript
      ? await summarizeTranscript(transcript)
      : null;
    const aiSummary = summaryResult?.text ?? null;

    // Twilio bills the recorded human call leg at the inbound or outbound
    // rate (a browser call is a plain voice leg — no media stream). OpenAI
    // bills Whisper per minute of audio ONLY when a transcript actually came
    // back (a null transcription was never billed), plus the gpt-4o-mini
    // summary by its actual tokens. Rates central.
    const twilioCost = priceTwilioCall(recordingDuration, call.direction);
    const openaiCost = Number(
      (
        (transcript ? priceWhisper(recordingDuration) : 0) +
        (summaryResult
          ? priceOpenAiTokens(
              summaryResult.promptTokens,
              summaryResult.completionTokens,
            )
          : 0)
      ).toFixed(4),
    );
    const prev = (call.cost_breakdown ?? {}) as Record<string, unknown>;
    const costBreakdown = withRecomputedTotal({
      ...prev,
      twilio: twilioCost,
      twilio_call: twilioCost,
      twilio_media_stream: 0,
      elevenlabs: numField(prev, "elevenlabs"),
      openai: openaiCost,
      lookup: numField(prev, "lookup"),
    });

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
  } catch {
    // Something threw (e.g. a network error mid-transcription). Release the
    // claim so Twilio's retry can re-process — we haven't written a result yet.
    if (recordingSid) {
      await supabase
        .from("twilio_recording_events")
        .delete()
        .eq("recording_sid", recordingSid);
    }
    return new Response("Error", { status: 500 });
  }

  return new Response("", { status: 204 });
}
