"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

export type SavedViewResult = { error: string | null };

/** Save the current filter/column combination as a named view. */
export async function createSavedView(
  page: string,
  name: string,
  params: string,
): Promise<SavedViewResult> {
  const trimmedName = name.trim();
  if (!trimmedName) return { error: "Enter a name for the view." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { error } = await supabase.from("saved_views").insert({
    user_id: user.id,
    page,
    name: trimmedName,
    params,
  });
  if (error) return { error: "Could not save the view." };

  // Revalidate every page that has its own views — cheap and avoids the
  // caller having to thread a path through.
  revalidatePath("/leads");
  revalidatePath("/calls");
  return { error: null };
}

/** Delete one of the current user's saved views. */
export async function deleteSavedView(id: string): Promise<SavedViewResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { error } = await supabase.from("saved_views").delete().eq("id", id);
  if (error) return { error: "Could not delete the view." };

  revalidatePath("/leads");
  revalidatePath("/calls");
  return { error: null };
}
