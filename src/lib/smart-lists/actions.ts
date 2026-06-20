"use server";

import { revalidatePath } from "next/cache";

import type { Json } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

import { validateRecipe, type RecipeNode } from "./recipe";

async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { supabase, ok: false as const, userId: "" };
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  return { supabase, ok: me?.role === "admin", userId: user.id };
}

const RPC_PAGE = 1000;

/** Evaluate a recipe to matching lead ids via the Postgres function. Pages the
 *  RPC (PostgREST caps each response at 1000) to return the full set. A broken
 *  recipe matches nothing (not everything). */
export async function matchingLeadIds(
  recipe: RecipeNode,
): Promise<{ ids: string[]; error: string | null }> {
  const { supabase, ok } = await requireAdmin();
  if (!ok) return { ids: [], error: "Admins only." };
  if (validateRecipe(recipe)) return { ids: [], error: "Invalid filter." };

  const all: string[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .rpc("leads_matching_filter", { in_recipe: recipe as unknown as Json })
      .range(from, from + RPC_PAGE - 1);
    if (error) return { ids: [], error: "Could not run the filter." };
    const batch = (data ?? []) as unknown as string[];
    all.push(...batch);
    if (batch.length < RPC_PAGE) break;
    from += RPC_PAGE;
    if (from > 100_000) break; // safety backstop
  }
  return { ids: all, error: null };
}

export async function saveSmartList(input: {
  id?: string;
  name: string;
  description?: string;
  recipe: RecipeNode;
}): Promise<{ error: string | null }> {
  const { supabase, ok, userId } = await requireAdmin();
  if (!ok) return { error: "Admins only." };
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
  const { supabase, ok } = await requireAdmin();
  if (!ok) return { error: "Admins only." };
  const { error } = await supabase
    .from("smart_lists")
    .delete()
    .eq("id", input.id);
  if (error) return { error: "Could not delete." };
  revalidatePath("/leads");
  return { error: null };
}
