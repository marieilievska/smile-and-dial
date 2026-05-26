"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

import { GOAL_STATUSES, type GoalStatus } from "./goal-statuses";

/**
 * Manually transition a lead through the goal pipeline statuses
 * (BUILD_PLAN §5.4). The owner or an admin can advance a lead from
 * `goal_met` → `attended` → `sale` / `closed`, or mark `no_show` etc.
 *
 * Writes a `goal_transition` row to `system_events` so we can see who
 * moved the lead when.
 */
export async function transitionLeadGoalStatus(input: {
  leadId: string;
  status: GoalStatus;
}): Promise<{ error: string | null }> {
  if (!GOAL_STATUSES.includes(input.status)) {
    return { error: "Pick a valid goal status." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: lead } = await supabase
    .from("leads")
    .select("status")
    .eq("id", input.leadId)
    .maybeSingle();
  if (!lead) return { error: "Lead not found." };
  const previousStatus = lead.status;

  const { error } = await supabase
    .from("leads")
    .update({ status: input.status })
    .eq("id", input.leadId);
  if (error) return { error: "Could not update the lead." };

  await supabase.from("system_events").insert({
    kind: "goal_transition",
    actor_user_id: user.id,
    ref_table: "leads",
    ref_id: input.leadId,
    payload: { from: previousStatus, to: input.status },
  });

  revalidatePath("/goals");
  return { error: null };
}
