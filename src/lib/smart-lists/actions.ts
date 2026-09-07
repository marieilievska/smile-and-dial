"use server";

import { revalidatePath } from "next/cache";

import type { Json } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

import { validateRecipe, type RecipeNode } from "./recipe";

/** Max smart lists one user may own — bounds the membership-refresh cron. */
const SMART_LIST_CAP = 50;

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

// matchingLeadIds() lived here: it resolved a recipe to the full array of
// matching lead ids by paging leads_matching_filter. Deleted 2026-09-07 with
// nothing calling it — the Leads page applies the recipe DB-side through
// leads_matching_filter_rows (#372) and the campaign preview now counts
// through the same function, so neither needs the ids in JavaScript. It was
// also the last paged reader of that scalar function.

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

  // Cap smart lists per user so the membership-refresh cron stays bounded.
  // Only enforced when CREATING a new list — editing an existing one is fine.
  if (!input.id) {
    const { count } = await supabase
      .from("smart_lists")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", userId);
    if ((count ?? 0) >= SMART_LIST_CAP) {
      return {
        error: `You've reached the limit of ${SMART_LIST_CAP} smart lists. Delete one to add another.`,
      };
    }
  }

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

  // Refuse while a campaign still targets this list. campaigns.smart_list_id
  // is `on delete set null`, so without this check the delete would quietly
  // detach the list and the campaign would carry on with a smaller audience
  // and no trace of why. RLS scopes the lookup to the caller's campaigns
  // (all of them for an admin, their own for a member — the ones that matter).
  const { data: users, error: usersError } = await supabase
    .from("campaigns")
    .select("name")
    .eq("smart_list_id", input.id)
    .order("name");
  if (usersError)
    return { error: "Could not check the smart list's campaigns." };
  if (users && users.length > 0) {
    const names = users.map((c) => c.name).join(", ");
    return {
      error: `This smart list is used by ${users.length} ${
        users.length === 1 ? "campaign" : "campaigns"
      }: ${names}. Detach it from those campaigns first.`,
    };
  }

  const { error } = await supabase
    .from("smart_lists")
    .delete()
    .eq("id", input.id);
  if (error) return { error: "Could not delete." };
  revalidatePath("/leads");
  return { error: null };
}
