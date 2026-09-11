import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, test } from "vitest";

import { buildLeadsQuery } from "@/app/(app)/leads/leads-query";
import type { SearchParams } from "@/app/(app)/leads/leads-url";

// Read the opt-in from the shell BEFORE loading .env.local, and load it only
// once opted in: a LEADS_SCALE_LIVE=1 line inside .env.local can't turn this
// on by itself, and a skipped run never loads the production keys.
const live = process.env.LEADS_SCALE_LIVE === "1";
if (live) loadEnv({ path: ".env.local", quiet: true });
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
 *
 * OPT-IN live check — skipped unless LEADS_SCALE_LIVE=1 is set in the shell,
 * the same gate the business-research live test uses for RESEARCH_LIVE.
 * Without it, this test would query the production Supabase project on every
 * `npm run test:unit` whenever a developer's .env.local happens to carry real
 * Supabase keys. The default suite guards the same fix offline, in
 * tests/leads-advanced-filter-rpc.unit.test.ts.
 *
 *   LEADS_SCALE_LIVE=1 npx vitest run tests/leads-advanced-filter-scale.unit.test.ts
 */
describe.skipIf(!live)("advanced filter at scale", () => {
  // A state that holds thousands of leads — enough that the id-list approach is
  // guaranteed to overflow. Verified against prod (CA ≈ 11.8k).
  const state = "CA";

  test("a recipe matching thousands of leads returns a filtered page, not an overflow error", async (ctx) => {
    // Opted in with nothing to connect to: say so, rather than skip in silence.
    if (!URL || !KEY) {
      ctx.skip(
        "LEADS_SCALE_LIVE=1, but NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set (shell or .env.local)",
      );
      return;
    }
    const admin = createClient(URL, KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // This test only means anything against a workspace that actually holds
    // enough leads to overflow the old id-list approach. After the 2026-09-08
    // wipe it holds none, and asserting against an empty database would leave
    // the suite permanently red — which hides real failures far more
    // effectively than this test catches the bug it was written for.
    const { count: available } = await admin
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("state", state);
    if ((available ?? 0) <= 1000) {
      ctx.skip(
        `needs >1000 ${state} leads to exercise the overflow path; found ${available ?? 0}`,
      );
      return;
    }

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
