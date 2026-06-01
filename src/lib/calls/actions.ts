"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

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

  // The transcript can be either an array of turns or an object that wraps
  // an array (e.g. { turns: [...] }). Be defensive.
  let transcript: TranscriptTurn[] = [];
  const tj = data.transcript_json;
  if (Array.isArray(tj)) {
    transcript = tj as TranscriptTurn[];
  } else if (
    tj &&
    typeof tj === "object" &&
    Array.isArray((tj as { turns?: unknown }).turns)
  ) {
    transcript = (tj as { turns: TranscriptTurn[] }).turns;
  }

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

  revalidatePath("/calls");
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

  revalidatePath("/calls");
  return { error: null };
}
