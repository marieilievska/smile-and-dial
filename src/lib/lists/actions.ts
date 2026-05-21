"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

export type ListActionResult = { error: string | null };

/** Create a list owned by the current user. */
export async function createList(
  name: string,
  description: string,
): Promise<ListActionResult> {
  const trimmedName = name.trim();
  if (!trimmedName) return { error: "Enter a list name." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { error } = await supabase.from("lists").insert({
    owner_id: user.id,
    name: trimmedName,
    description: description.trim() || null,
  });
  if (error) return { error: "Could not create the list." };

  revalidatePath("/settings/lists");
  return { error: null };
}

/** Rename or re-describe a list. RLS limits this to the owner (or an admin). */
export async function updateList(
  id: string,
  name: string,
  description: string,
): Promise<ListActionResult> {
  const trimmedName = name.trim();
  if (!trimmedName) return { error: "Enter a list name." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { error } = await supabase
    .from("lists")
    .update({ name: trimmedName, description: description.trim() || null })
    .eq("id", id);
  if (error) return { error: "Could not update the list." };

  revalidatePath("/settings/lists");
  return { error: null };
}

/** Delete a list. RLS limits this to the owner (or an admin). */
export async function deleteList(id: string): Promise<ListActionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { error } = await supabase.from("lists").delete().eq("id", id);
  if (error) return { error: "Could not delete the list." };

  revalidatePath("/settings/lists");
  return { error: null };
}
