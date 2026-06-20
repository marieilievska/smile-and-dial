import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";

import { EMPTY_RECIPE, type RecipeNode } from "./recipe";

type DB = SupabaseClient<Database>;

const RPC_PAGE = 1000;

/** Parse the `recipe` search param (URL-encoded JSON). null when absent or
 *  unparseable (caller treats null as "no recipe filter"). */
export function parseRecipeParam(raw: string | undefined): RecipeNode | null {
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as RecipeNode) ?? null;
  } catch {
    return null;
  }
}

/** Run the recipe through the Postgres filter function, paging past PostgREST's
 *  1,000-row response cap to get the full id set. */
export async function runFilterRpc(
  supabase: DB,
  recipe: RecipeNode,
): Promise<{ ids: string[]; error: string | null }> {
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

/** Resolve the `recipe` param to matching lead ids, or null when there's no
 *  effective recipe (absent, unparseable, or an empty top-level group). */
export async function resolveRecipeIds(
  supabase: DB,
  raw: string | undefined,
): Promise<string[] | null> {
  const recipe = parseRecipeParam(raw);
  if (!recipe) return null;
  const empty =
    JSON.stringify(recipe) === JSON.stringify(EMPTY_RECIPE) ||
    ("children" in recipe && recipe.children.length === 0);
  if (empty) return null;
  const { ids } = await runFilterRpc(supabase, recipe);
  return ids;
}
