"use server";

import { applyRetryForCall } from "@/lib/dialer/retry-engine";
import { applyOutcomeSideEffects } from "@/lib/elevenlabs/post-call-webhook";
import { OVERRIDABLE_OUTCOMES } from "@/lib/calls/outcomes";
import { syncLeadCallCounters } from "@/lib/leads/call-counters";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Set the outcome of the user's own human call to a lead, then run the SAME
 * retry/side-effect pipeline AI calls use. The note is appended to the call
 * summary.
 *
 * The call is pinned by the Twilio CallSid the softphone saw (the parent leg's
 * SID, which is what voice-browser-dial stamped on the row); without one we
 * fall back to the caller's latest human call to the lead. Either way the row
 * must have been placed_by this user — a member can never relabel a teammate's
 * call, and the lead itself must be visible to them under RLS.
 */
export async function dispositionHumanCall(input: {
  leadId: string;
  outcome: string;
  note?: string;
  /** `call.parameters.CallSid` from the browser call that just ended. */
  callSid?: string | null;
}): Promise<{ error?: string }> {
  const authed = await createClient();
  const {
    data: { user },
  } = await authed.auth.getUser();
  if (!user) return { error: "Not authenticated" };
  if (!OVERRIDABLE_OUTCOMES.includes(input.outcome as never)) {
    return { error: "Pick a valid outcome." };
  }

  // RLS: members only see their own leads. Refuse before touching anything
  // with the service client.
  const { data: visibleLead } = await authed
    .from("leads")
    .select("id")
    .eq("id", input.leadId)
    .maybeSingle();
  if (!visibleLead) return { error: "This lead is not available to you." };

  const supabase = createAdminClient();
  const ownCalls = supabase
    .from("calls")
    .select("id, summary, campaign_id, started_at, ended_at")
    .eq("lead_id", input.leadId)
    .eq("call_mode", "human")
    .eq("placed_by", user.id);
  const callSid = input.callSid?.trim();
  const { data: call } = callSid
    ? await ownCalls.eq("twilio_call_sid", callSid).maybeSingle()
    : await ownCalls
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
  if (!call) return { error: "No recent human call of yours to update." };

  const summary = input.note?.trim()
    ? [call.summary, `Note: ${input.note.trim()}`].filter(Boolean).join("\n")
    : call.summary;

  // Dispositioning a human call also terminalizes it: set status='completed'
  // and stamp ended_at (only when not already set, so we don't move a real end
  // time the Dial-completion/recording callback already wrote). This guarantees
  // a dispositioned call is fully terminal and never reaped.
  await supabase
    .from("calls")
    .update({
      outcome: input.outcome,
      outcome_source: "manual",
      goal_met: input.outcome === "goal_met",
      summary,
      status: "completed",
      ended_at: call.ended_at ?? new Date().toISOString(),
    })
    .eq("id", call.id);

  // Route through the SAME pipeline AI calls use: this creates callback rows,
  // inserts DNC entries (+ flips the lead to dnc), fires the goal-met
  // notification, AND drives the retry engine for the remaining outcomes.
  // applyRetryForCall alone bails on dnc/callback/etc., silently dropping them.
  if (call.campaign_id) {
    await applyOutcomeSideEffects(supabase, {
      callId: call.id,
      leadId: input.leadId,
      campaignId: call.campaign_id,
      outcome: input.outcome as never,
      callbackDatetime: null,
    });
  } else {
    // No campaign on the row — applyOutcomeSideEffects needs a campaignId for
    // callback rows, so fall back to at least running retry scheduling.
    await applyRetryForCall(call.id);
  }

  // Keep the lead's counters honest, exactly like an AI call does: last_call_at
  // reflects this call (never moved backwards past a newer call), and
  // Attempts / Conversations are recomputed from the calls table now that the
  // outcome — possibly adjusted by the side effects above — is final.
  const lastCallAt =
    call.started_at ?? call.ended_at ?? new Date().toISOString();
  await supabase
    .from("leads")
    .update({ last_call_at: lastCallAt })
    .eq("id", input.leadId)
    .or(`last_call_at.is.null,last_call_at.lt.${lastCallAt}`);
  await syncLeadCallCounters(supabase, input.leadId);

  return {};
}
