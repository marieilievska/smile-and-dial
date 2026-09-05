"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

import { GOAL_STATUSES, type GoalStatus } from "./goal-statuses";
import { pickRegistrationToMark } from "./pick-registration";

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

  // Write the outcome through to the REGISTRATION, which is the thing that
  // actually owns it. `leads.status` holds only CURRENT state, so a no-show who
  // rebooks and attends would otherwise overwrite their own history, and a data
  // wipe would erase the outcome entirely. The registration also carries the
  // dial_day, which is what lets cohort reporting credit the right day's spend.
  if (input.status === "attended" || input.status === "sale") {
    const { data: regs } = await supabase
      .from("calendly_events")
      .select("id, scheduled_at, attended_at")
      .eq("lead_id", input.leadId)
      .neq("status", "canceled");
    const target = pickRegistrationToMark(regs ?? []);
    if (target) {
      const stamp = new Date().toISOString();
      await supabase
        .from("calendly_events")
        .update(
          input.status === "sale"
            ? // A sale implies they attended. Without this backfill the close
              // rate divides by an attendee count that is missing them.
              { sale_at: stamp, attended_at: target.attended_at ?? stamp }
            : { attended_at: stamp },
        )
        .eq("id", target.id);
    }
  }

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
