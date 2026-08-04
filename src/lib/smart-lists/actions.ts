"use server";

import { revalidatePath } from "next/cache";

import type { Json } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

import { validateRecipe, type RecipeNode } from "./recipe";
import { runFilterRpc } from "./resolve";

/** Any signed-in user. Smart lists are owner-scoped: the actions set owner_id on
 *  insert and RLS (owner-or-admin) backstops read/update/delete, so a member
 *  only ever manages their own. The refresh_smart_list SECURITY DEFINER function
 *  scopes membership to the list owner's leads, so a member's list can never
 *  contain another account's leads. */
async function requireAuth() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, ok: Boolean(user), userId: user?.id ?? "" };
}

/** Evaluate a recipe to matching lead ids (admin-gated). A broken recipe
 *  matches nothing (not everything). */
export async function matchingLeadIds(
  recipe: RecipeNode,
): Promise<{ ids: string[]; error: string | null }> {
  const { supabase, ok } = await requireAuth();
  if (!ok) return { ids: [], error: "You are not signed in." };
  if (validateRecipe(recipe)) return { ids: [], error: "Invalid filter." };
  return runFilterRpc(supabase, recipe);
}

export async function saveSmartList(input: {
  id?: string;
  name: string;
  description?: string;
  recipe: RecipeNode;
}): Promise<{ error: string | null }> {
  const { supabase, ok, userId } = await requireAuth();
  if (!ok) return { error: "You are not signed in." };
  if (!input.name.trim()) return { error: "Name is required." };
  if (validateRecipe(input.recipe)) return { error: "Invalid filter." };

  const fields = {
    name: input.name.trim(),
    description: input.description?.trim() || null,
    filter: input.recipe as unknown as Json,
    updated_at: new Date().toISOString(),
  };
  const res = input.id
    ? await supabase.from("smart_lists").update(fields).eq("id", input.id)
    : await supabase
        .from("smart_lists")
        .insert({ ...fields, owner_id: userId });
  if (res.error) return { error: "Could not save the smart list." };
  revalidatePath("/leads");
  return { error: null };
}

export async function deleteSmartList(input: {
  id: string;
}): Promise<{ error: string | null }> {
  const { supabase, ok } = await requireAuth();
  if (!ok) return { error: "You are not signed in." };
  const { error } = await supabase
    .from("smart_lists")
    .delete()
    .eq("id", input.id);
  if (error) return { error: "Could not delete." };
  revalidatePath("/leads");
  return { error: null };
}
