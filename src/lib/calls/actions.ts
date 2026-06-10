"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

import { syncLeadNextCallToEarliestCallback } from "@/lib/callbacks/sync-next-call";
import { applyRetryForCall } from "@/lib/dialer/retry-engine";

export type TranscriptTurn = {
  role?: string;
  text?: string;
  started_at?: string | number;
  ended_at?: string | number;
};

export type CallDetail = {
  id: string;
  direction: "outbound" | "inbound";
  status: string;
  outcome: string | null;
  outcomeSource: string | null;
  goalMet: boolean;
  startedAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  talkTimeSeconds: number | null;
  recordingPath: string | null;
  /** A directly-playable URL for the recording: a short-lived signed URL
   *  when recording_path is a storage object, or the stored URL as-is for
   *  legacy rows that kept a full ElevenLabs URL. null when no recording. */
  recordingUrl: string | null;
  score: number | null;
  summary: string | null;
  transcript: TranscriptTurn[];
  extractedData: Record<string, unknown> | null;
  costBreakdown: Record<string, unknown> | null;
  twilioCallSid: string | null;
  elevenlabsConversationId: string | null;
  leadId: string | null;
  leadCompany: string | null;
  leadPhone: string | null;
  campaignName: string;
  agentName: string;
};

export type CallDetailResult =
  | { call: CallDetail; error: null }
  | { call: null; error: string };

/**
 * Server action that fetches one call with everything the detail modal needs.
 * RLS scopes it for members (only their leads' calls); admins see everything.
 */
export async function getCallDetail(callId: string): Promise<CallDetailResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { call: null, error: "You are not signed in." };

  const { data: raw, error } = await supabase
    .from("calls")
    .select(
      "id, direction, status, outcome, outcome_source, goal_met, " +
        "started_at, answered_at, ended_at, duration_seconds, talk_time_seconds, " +
        "recording_path, score, summary, transcript_json, extracted_data, " +
        "cost_breakdown, twilio_call_sid, elevenlabs_conversation_id, " +
        "lead:leads(id, company, business_phone), " +
        "campaign:campaigns(name), agent:agents(name)",
    )
    .eq("id", callId)
    .maybeSingle();
  if (error) return { call: null, error: "Could not load the call." };
  if (!raw) return { call: null, error: "Call not found." };

  // The select string is too rich for the Supabase type generator to keep
  // narrow inference, so we cast to a hand-typed shape for the reads.
  type Joined = {
    id: string;
    direction: string;
    status: string;
    outcome: string | null;
    outcome_source: string | null;
    goal_met: boolean;
    started_at: string | null;
    answered_at: string | null;
    ended_at: string | null;
    duration_seconds: number | null;
    talk_time_seconds: number | null;
    recording_path: string | null;
    score: number | string | null;
    summary: string | null;
    transcript_json: unknown;
    extracted_data: unknown;
    cost_breakdown: unknown;
    twilio_call_sid: string | null;
    elevenlabs_conversation_id: string | null;
    lead: {
      id: string;
      company: string | null;
      business_phone: string | null;
    } | null;
    campaign: { name: string } | null;
    agent: { name: string } | null;
  };
  const data = raw as unknown as Joined;

  // transcript_json holds ElevenLabs' raw transcript array. Each turn is
  // { role: "user"|"agent", message: string|null, time_in_call_secs: number,
  // tool_calls?, … } — NOT our { text, started_at } shape. Older/test rows used
  // { text, started_at }, and some payloads wrap the array in { transcript: […] }
  // or { turns: […] }. Human browser-call recordings store a single Whisper
  // transcript as { text: string } (no per-turn breakdown). Normalize all of
  // them into TranscriptTurn and drop turns with no spoken text (e.g. pure
  // tool-call turns like voicemail_detection).
  const tj = data.transcript_json;
  const rawTurns: unknown[] = Array.isArray(tj)
    ? tj
    : tj &&
        typeof tj === "object" &&
        Array.isArray((tj as { transcript?: unknown }).transcript)
      ? (tj as { transcript: unknown[] }).transcript
      : tj &&
          typeof tj === "object" &&
          Array.isArray((tj as { turns?: unknown }).turns)
        ? (tj as { turns: unknown[] }).turns
        : // Human-call shape: a flat { text: string } from Whisper. Render it as
          // one synthetic turn. role 'agent' makes the modal label it "AI" and
          // show it as a left-aligned bubble; no start time (it's not a turn).
          tj &&
            typeof tj === "object" &&
            typeof (tj as { text?: unknown }).text === "string" &&
            (tj as { text: string }).text.trim().length > 0
          ? [{ role: "agent", text: (tj as { text: string }).text }]
          : [];
  const transcript: TranscriptTurn[] = rawTurns
    .map((t): TranscriptTurn => {
      const turn = (t ?? {}) as Record<string, unknown>;
      const text =
        typeof turn.message === "string"
          ? turn.message
          : typeof turn.text === "string"
            ? turn.text
            : "";
      const startedAt =
        typeof turn.time_in_call_secs === "number"
          ? turn.time_in_call_secs
          : typeof turn.started_at === "number" ||
              typeof turn.started_at === "string"
            ? (turn.started_at as number | string)
            : undefined;
      return {
        role: typeof turn.role === "string" ? turn.role : undefined,
        text,
        started_at: startedAt,
      };
    })
    .filter((t) => typeof t.text === "string" && t.text.trim().length > 0);

  // Resolve a playable URL. The recording lives in the private
  // `call-recordings` bucket (object path like "<callId>.mp3"), so mint a
  // short-lived signed URL. Legacy rows may hold a full http(s) URL instead
  // — pass those through unchanged.
  let recordingUrl: string | null = null;
  if (data.recording_path) {
    if (/^https?:\/\//i.test(data.recording_path)) {
      recordingUrl = data.recording_path;
    } else {
      const { data: signed } = await supabase.storage
        .from("call-recordings")
        .createSignedUrl(data.recording_path, 60 * 60);
      recordingUrl = signed?.signedUrl ?? null;
    }
  }

  return {
    error: null,
    call: {
      id: data.id,
      direction: data.direction as CallDetail["direction"],
      status: data.status,
      outcome: data.outcome,
      outcomeSource: data.outcome_source,
      goalMet: data.goal_met,
      startedAt: data.started_at,
      answeredAt: data.answered_at,
      endedAt: data.ended_at,
      durationSeconds: data.duration_seconds,
      talkTimeSeconds: data.talk_time_seconds,
      recordingPath: data.recording_path,
      recordingUrl,
      score: data.score == null ? null : Number(data.score),
      summary: data.summary,
      transcript,
      extractedData: (data.extracted_data ?? null) as Record<
        string,
        unknown
      > | null,
      costBreakdown: (data.cost_breakdown ?? null) as Record<
        string,
        unknown
      > | null,
      twilioCallSid: data.twilio_call_sid,
      elevenlabsConversationId: data.elevenlabs_conversation_id,
      leadId: data.lead?.id ?? null,
      leadCompany: data.lead?.company ?? null,
      leadPhone: data.lead?.business_phone ?? null,
      campaignName: data.campaign?.name ?? "—",
      agentName: data.agent?.name ?? "—",
    },
  };
}

export type ActionResult = { error: string | null };

/**
 * Manually override a call's outcome from the detail modal. Updates
 * `calls.outcome` and stamps `outcome_source='manual'`, then writes an
 * `outcome_override` row to `system_events` so we have an audit trail of
 * who changed what to what.
 *
 * Intentionally does NOT re-trigger the retry engine or any downstream
 * side effects (DNC insert, callback creation). Overrides change the
 * historical record; if a user also wants to act on the new outcome,
 * they take that action separately (Call Now button, manual DNC, etc.).
 */
export async function overrideCallOutcome(input: {
  callId: string;
  outcome: string;
}): Promise<ActionResult> {
  const { OVERRIDABLE_OUTCOMES } = await import("./outcomes");
  if (!OVERRIDABLE_OUTCOMES.includes(input.outcome as never)) {
    return { error: "Pick a valid outcome." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: existing } = await supabase
    .from("calls")
    .select("outcome")
    .eq("id", input.callId)
    .maybeSingle();
  if (!existing) return { error: "Call not found." };
  const previousOutcome = existing.outcome;

  const { error: callError } = await supabase
    .from("calls")
    .update({
      outcome: input.outcome,
      outcome_source: "manual",
      goal_met: input.outcome === "goal_met",
    })
    .eq("id", input.callId);
  if (callError) return { error: "Could not update the call." };

  // Audit log. RLS requires actor_user_id == auth.uid().
  await supabase.from("system_events").insert({
    kind: "outcome_override",
    actor_user_id: user.id,
    ref_table: "calls",
    ref_id: input.callId,
    payload: {
      from: previousOutcome,
      to: input.outcome,
    },
  });

  // Re-run scheduling so the lead's next call reflects the corrected outcome
  // (e.g. a hang-up should move to the 2-day retry, not keep a stale "in a few
  // minutes" placeholder). Clearing retry_applied_at lets the engine re-claim.
  await supabase
    .from("calls")
    .update({ retry_applied_at: null })
    .eq("id", input.callId);
  try {
    await applyRetryForCall(input.callId);
  } catch {
    // Best-effort: the outcome is corrected even if rescheduling hiccups.
  }

  revalidatePath("/calls");
  revalidatePath("/leads");
  return { error: null };
}

/**
 * Schedule a callback for a call from the detail modal. Inserts a
 * `callbacks` row with `created_by` = the current user (vs. the
 * post-call webhook's auto-creates which leave created_by null).
 */
export async function scheduleManualCallback(input: {
  callId: string;
  scheduledAt: string;
}): Promise<ActionResult> {
  const when = new Date(input.scheduledAt);
  if (Number.isNaN(when.getTime())) {
    return { error: "Pick a valid date and time." };
  }
  if (when.getTime() <= Date.now()) {
    return { error: "Pick a time in the future." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: call } = await supabase
    .from("calls")
    .select("lead_id, campaign_id")
    .eq("id", input.callId)
    .maybeSingle();
  if (!call) return { error: "Call not found." };

  const { error } = await supabase.from("callbacks").insert({
    lead_id: call.lead_id,
    campaign_id: call.campaign_id,
    originating_call_id: input.callId,
    scheduled_at: when.toISOString(),
    status: "pending",
    created_by: user.id,
  });
  if (error) return { error: "Could not schedule the callback." };

  // Move the lead into the callback queue at its earliest pending callback so
  // the dialer actually picks it up (a manually-scheduled callback otherwise
  // never set the lead's status / next_call_at).
  if (call.lead_id) {
    await syncLeadNextCallToEarliestCallback(supabase, call.lead_id);
  }

  revalidatePath("/calls");
  return { error: null };
}

export type DeleteCallsResult = {
  error: string | null;
  deleted?: number;
};

/**
 * Permanently delete calls (admin only). Calls are normally immutable audit
 * history, so this is a deliberate escape hatch for clearing test/junk rows.
 * Hard delete: removes the call rows and their recordings from storage; the
 * call drops out of cost/analytics totals. FK references (callbacks, emails)
 * are ON DELETE SET NULL, so related records survive with the link cleared.
 * Runs via the service role (there's no delete RLS policy on calls), but only
 * after confirming the caller is an admin.
 */
export async function deleteCalls(ids: string[]): Promise<DeleteCallsResult> {
  const clean = [...new Set(ids.filter((id) => typeof id === "string" && id))];
  if (clean.length === 0) return { error: "No calls selected." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") return { error: "Only an admin can delete calls." };

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) return { error: "Server is missing Supabase credentials." };
  const admin = createAdminClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Remove recordings stored in the private bucket (object paths, not legacy
  // http URLs) so deleting a call doesn't orphan its audio. Best-effort.
  const { data: rows } = await admin
    .from("calls")
    .select("recording_path")
    .in("id", clean);
  const objects = (rows ?? [])
    .map((r) => r.recording_path)
    .filter(
      (p): p is string => Boolean(p) && !/^https?:\/\//i.test(p as string),
    );
  if (objects.length > 0) {
    await admin.storage.from("call-recordings").remove(objects);
  }

  const { error } = await admin.from("calls").delete().in("id", clean);
  if (error) return { error: "Could not delete the selected calls." };

  // The call list, plus everything that aggregates over calls.
  revalidatePath("/calls");
  revalidatePath("/analytics");
  revalidatePath("/costs");
  revalidatePath("/today");
  return { error: null, deleted: clean.length };
}
