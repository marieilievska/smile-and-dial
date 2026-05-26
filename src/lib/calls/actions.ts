"use server";

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
