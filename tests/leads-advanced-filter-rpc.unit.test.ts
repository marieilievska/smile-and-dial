import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { buildLeadsQuery } from "@/app/(app)/leads/leads-query";
import type { SearchParams } from "@/app/(app)/leads/leads-url";

/**
 * Offline guard for the advanced-filter HTTP 414 fix (#372), run on every
 * `npm run test:unit`.
 *
 * The bug: a filter recipe was resolved to every matching lead id, and the
 * whole list went into the request URL as `.in("id", …)`. Once a filter matched
 * a few hundred leads the URL was too long, the server answered HTTP 414
 * "Request-URI Too Large", and the Leads page silently showed nothing. The fix
 * sends the recipe itself, in the BODY of one POST to the database function
 * `leads_matching_filter_rows`, so the URL stays the same size however many
 * leads match.
 *
 * tests/leads-advanced-filter-scale.unit.test.ts proves the same thing against
 * production data, but it is opt-in (#521), so this is the check the default
 * suite relies on.
 *
 * Nothing leaves the machine: the client's fetch is a spy that records each
 * request and answers with an empty page, and `.invalid` is a reserved domain
 * that never resolves.
 */

type Captured = { method: string; url: string; body: string | null };

/** A Supabase client whose every request is recorded and answered locally. */
function offlineClient() {
  const requests: Captured[] = [];
  const fetchSpy: typeof fetch = async (input, init) => {
    requests.push({
      method: init?.method ?? "GET",
      url: String(input),
      body: typeof init?.body === "string" ? init.body : null,
    });
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json", "content-range": "*/0" },
    });
  };
  const client = createClient("https://offline.invalid", "offline-key", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: fetchSpy },
  });
  return { client, requests };
}

describe("advanced filter request (offline)", () => {
  // The recipe the live scale test uses: every lead in one state.
  const recipe = {
    combinator: "and",
    children: [{ field: "state", operator: "is", value: "CA" }],
  };

  it.each([
    { view: "no other filters", extra: {} },
    { view: "with the Called filter", extra: { called: "yes" } },
  ])(
    "sends the recipe in one POST body, not as an id list in the URL ($view)",
    async ({ extra }) => {
      const { client, requests } = offlineClient();
      const params: SearchParams = { recipe: JSON.stringify(recipe), ...extra };

      const { error } = await buildLeadsQuery(client as never, params)
        .order("created_at", { ascending: false })
        .range(0, 49);

      expect(error).toBeNull();
      expect(requests).toHaveLength(1);
      const [request] = requests;
      expect(request.url).not.toContain("id=in.");
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe(
        "/rest/v1/rpc/leads_matching_filter_rows",
      );
      expect(JSON.parse(request.body ?? "null")).toEqual({ in_recipe: recipe });
    },
  );
});
