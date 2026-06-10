"use server";

import { applyRetryForCall } from "@/lib/dialer/retry-engine";
import { applyOutcomeSideEffects } from "@/lib/elevenlabs/post-call-webhook";
import { OVERRIDABLE_OUTCOMES } from "@/lib/calls/outcomes";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Set the outcome of the user's most recent human call to a lead, then run the
 * SAME retry/side-effect pipeline AI calls use. The note is appended to the
 * call summary.
 */
export async function dispositionHumanCall(input: {
  leadId: string;
  outcome: string;
  note?: string;
}): Promise<{ error?: string }> {
  const authed = await createClient();
  const {
    data: { user },
  } = await authed.auth.getUser();
  if (!user) return { error: "Not authenticated" };
  if (!OVERRIDABLE_OUTCOMES.includes(input.outcome as never)) {
    return { error: "Pick a valid outcome." };
  }

  const supabase = createAdminClient();
  const { data: call } = await supabase
    .from("calls")
    .select("id, summary, campaign_id, ended_at")
    .eq("lead_id", input.leadId)
    .eq("call_mode", "human")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!call) return { error: "No recent human call to update." };

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
  return {};
}
