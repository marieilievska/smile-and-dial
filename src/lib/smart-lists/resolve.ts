import { type RecipeNode } from "./recipe";

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

// runFilterRpc() lived here: it paged `leads_matching_filter` 1,000 ids at a
// time to resolve a recipe to the full array of matching lead ids. Deleted
// 2026-09-07 along with its last two callers.
//
// Nothing needs the ids in JavaScript any more. The Leads page applies the
// recipe DB-side by using `leads_matching_filter_rows` as the query source
// (#372, after a giant `.in()` produced an HTTP 414), and the campaign
// "matches N leads" preview counts through that same function with
// `count=exact` + `head`, which is one round trip and no rows on the wire —
// 23,121ms to 831ms on a filter matching 83,384 leads.
//
// It was also the app's last paged read without an ORDER BY, and the one
// exception tests/pager-ordering.unit.test.ts had to carry. That file now
// allows none.
