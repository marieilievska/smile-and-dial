"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

export type GoalActionResult = { error: string | null };

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/** Clear the default flag on the owner's other goals — only one default. */
async function clearOtherDefaults(
  supabase: SupabaseServerClient,
  ownerId: string,
  keepId: string,
) {
  await supabase
    .from("goals")
    .update({ is_default: false })
    .eq("owner_id", ownerId)
    .eq("is_default", true)
    .neq("id", keepId);
}

/** Create a goal owned by the current user. */
export async function createGoal(
  name: string,
  description: string,
  isDefault: boolean,
): Promise<GoalActionResult> {
  const trimmedName = name.trim();
  if (!trimmedName) return { error: "Enter a goal name." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: created, error } = await supabase
    .from("goals")
    .insert({
      owner_id: user.id,
      name: trimmedName,
      description: description.trim() || null,
      is_default: isDefault,
    })
    .select("id")
    .single();
  if (error || !created) return { error: "Could not create the goal." };

  if (isDefault) await clearOtherDefaults(supabase, user.id, created.id);

  revalidatePath("/goals");
  revalidatePath("/settings/goals");
  return { error: null };
}

/** Rename or re-describe a goal. RLS limits this to the owner (or an admin). */
export async function updateGoal(
  id: string,
  name: string,
  description: string,
  isDefault: boolean,
): Promise<GoalActionResult> {
  const trimmedName = name.trim();
  if (!trimmedName) return { error: "Enter a goal name." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { error } = await supabase
    .from("goals")
    .update({
      name: trimmedName,
      description: description.trim() || null,
      is_default: isDefault,
    })
    .eq("id", id);
  if (error) return { error: "Could not update the goal." };

  if (isDefault) await clearOtherDefaults(supabase, user.id, id);

  revalidatePath("/goals");
  revalidatePath("/settings/goals");
  return { error: null };
}

/**
 * Delete a goal. Blocks deletion if at least one non-ended campaign
 * still references it — that would orphan the campaign and break the
 * goals pipeline. The UI also disables the trigger button when usage
 * count > 0, but we re-check server-side here as a guard.
 */
export async function deleteGoal(id: string): Promise<GoalActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { count } = await supabase
    .from("campaigns")
    .select("id", { count: "exact", head: true })
    .eq("goal_id", id)
    .neq("status", "ended");
  if ((count ?? 0) > 0) {
    return {
      error: `This goal is used by ${count} active campaign${count === 1 ? "" : "s"}. Reassign the campaign${count === 1 ? "" : "s"} first.`,
    };
  }

  const { error } = await supabase.from("goals").delete().eq("id", id);
  if (error) return { error: "Could not delete the goal." };

  revalidatePath("/goals");
  revalidatePath("/settings/goals");
  return { error: null };
}
