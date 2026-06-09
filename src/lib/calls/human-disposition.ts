"use server";

import { applyRetryForCall } from "@/lib/dialer/retry-engine";
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
    .select("id, summary")
    .eq("lead_id", input.leadId)
    .eq("call_mode", "human")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!call) return { error: "No recent human call to update." };

  const summary = input.note?.trim()
    ? [call.summary, `Note: ${input.note.trim()}`].filter(Boolean).join("\n")
    : call.summary;

  await supabase
    .from("calls")
    .update({
      outcome: input.outcome,
      outcome_source: "manual",
      goal_met: input.outcome === "goal_met",
      summary,
    })
    .eq("id", call.id);

  await applyRetryForCall(call.id);
  return {};
}
