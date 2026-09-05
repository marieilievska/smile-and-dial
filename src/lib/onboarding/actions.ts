"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

/** Stamp one of the self-service onboarding columns on the caller's own
 *  profile. Goes through `update_my_profile` (20260905190000) because the
 *  profiles UPDATE policy is admin-only: a direct update matched zero rows
 *  for a member and reported success, so the welcome primer and the
 *  Getting-started card came back on every visit. The function returns the
 *  row count, and zero is treated as a failure rather than a save. */
async function stampProfile(
  column: "welcome_seen_at" | "onboarding_dismissed_at",
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const now = new Date().toISOString();
  const patch =
    column === "welcome_seen_at"
      ? { welcome_seen_at: now }
      : { onboarding_dismissed_at: now };

  const { data: updated, error } = await supabase.rpc("update_my_profile", {
    patch,
  });
  if (error || !updated) return { error: "Could not save your preference." };

  revalidatePath("/today");
  return { error: null };
}

/** Remember that the user has seen the one-time welcome primer. */
export async function markWelcomeSeen() {
  return stampProfile("welcome_seen_at");
}

/** Hide the Getting started checklist card (the user chose "Hide for now"). */
export async function dismissOnboarding() {
  return stampProfile("onboarding_dismissed_at");
}
