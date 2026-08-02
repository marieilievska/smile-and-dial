"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

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

  const { error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("id", user.id);
  if (error) return { error: "Could not save your preference." };

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
