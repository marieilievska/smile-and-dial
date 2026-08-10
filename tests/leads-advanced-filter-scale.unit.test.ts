import { config as loadEnv } from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, test } from "vitest";

import { buildLeadsQuery } from "@/app/(app)/leads/leads-query";
import type { SearchParams } from "@/app/(app)/leads/leads-url";

loadEnv({ path: ".env.local" });

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

/**
 * Contract for the advanced-filter (recipe) scale bug: a recipe that matches
 * more leads than fit in a single id-list URL must still return the correct,
 * filtered page. The old path resolved the recipe to every matching id and
 * passed the whole array to `.in("id", …)`, overflowing the request URL once a
 * few hundred leads matched — so the Leads page silently returned nothing.
 *
 * Read-only: we lean on the production data set, where a broad filter (a whole
 * state) already matches far more leads than any request URL can carry. No rows
 * are created or deleted.
 */
describe.skipIf(!URL || !KEY)("advanced filter at scale", () => {
  let admin: SupabaseClient;
  // A state that holds thousands of leads — enough that the id-list approach is
  // guaranteed to overflow. Verified against prod (CA ≈ 11.8k).
  const state = "CA";

  beforeAll(() => {
    admin = createClient(URL, KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  });

  test("a recipe matching thousands of leads returns a filtered page, not an overflow error", async () => {
    const recipe = {
      combinator: "and",
      children: [{ field: "state", operator: "is", value: state }],
    };
    const params = { recipe: JSON.stringify(recipe) } as SearchParams;

    const { data, error, count } = await buildLeadsQuery(admin as never, params)
      .order("created_at", { ascending: false })
      .range(0, 49);

    expect(error).toBeNull();
    expect(count ?? 0).toBeGreaterThan(1000);
    expect(data?.length).toBe(50);
    const rows = (data ?? []) as unknown as { state: string | null }[];
    expect(rows.every((r) => r.state === state)).toBe(true);
  }, 60_000);
});
