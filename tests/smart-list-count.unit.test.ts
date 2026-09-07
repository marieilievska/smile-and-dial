// tests/smart-list-count.unit.test.ts
//
// The "matches N leads" preview in campaign settings used to page every
// matching lead id into JavaScript and return `ids.length`. For a filter
// matching most of the table that is 84 sequential round trips to produce one
// integer. Measured on production 2026-09-07:
//
//   status is ready_to_call  (83,384 matches)   23,121ms  ->  831ms
//   created in last 7 days   (84,032 matches)   26,941ms  ->  813ms
//
// A broad filter is the first thing anyone tries, so the preview taking half a
// minute is most of why this feature has sat unused since June.
//
// Two things have to stay true for the fast path to be correct, and neither is
// visible from the call site:
//
//   1. It counts through `leads_matching_filter_rows`, which returns
//      `setof leads`. PostgREST can only put `count=exact` + `head` on a
//      TABLE-valued function; the scalar `leads_matching_filter` (setof uuid)
//      cannot be counted that way, which is why the slow version existed.
//   2. Both functions build their predicate from the same
//      `_smart_list_node_sql`, so the number this counts and the rows the Leads
//      page lists cannot drift apart.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATIONS = "supabase/migrations";

function read(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

/** Newest migration defining `needle`, comments stripped. */
function latestDefining(needle: string): string {
  const dir = fileURLToPath(new URL(`../${MIGRATIONS}`, import.meta.url));
  const hit = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .reverse()
    .map((f) => read(`${MIGRATIONS}/${f}`))
    .find((sql) => sql.includes(needle));
  if (!hit) throw new Error(`no migration defines ${needle}`);
  return hit.replace(/--[^\n]*/g, "");
}

const audienceActions = read("src/lib/campaigns/audience-actions.ts");
const smartListActions = read("src/lib/smart-lists/actions.ts");
const resolve = read("src/lib/smart-lists/resolve.ts");

describe("the smart-list preview counts instead of listing", () => {
  it("asks Postgres for the count and takes no rows", () => {
    const fn = audienceActions.slice(
      audienceActions.indexOf("export async function countSmartListMatches"),
    );
    expect(fn).toContain("leads_matching_filter_rows");
    expect(fn).toMatch(/count:\s*"exact"/);
    expect(fn).toMatch(/head:\s*true/);
  });

  it("counts through the TABLE-valued function, not the scalar one", () => {
    // `leads_matching_filter` returns setof uuid. PostgREST cannot apply
    // count=exact to it, so reaching for it here would silently put the 84
    // round trips back.
    const fn = audienceActions.slice(
      audienceActions.indexOf("export async function countSmartListMatches"),
    );
    expect(fn).not.toMatch(/rpc\(\s*"leads_matching_filter"/);
  });

  it("no longer pages ids into JavaScript anywhere", () => {
    for (const [name, src] of [
      ["audience-actions", audienceActions],
      ["smart-lists/actions", smartListActions],
      ["smart-lists/resolve", resolve],
    ] as const) {
      const code = src
        .split("\n")
        .filter(
          (l) =>
            !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"),
        )
        .join("\n");
      expect(code, `${name} still pages`).not.toContain("runFilterRpc");
      expect(code, `${name} still pages`).not.toMatch(/\.range\(/);
    }
  });
});

describe("the count and the list cannot drift apart", () => {
  it("both functions build their predicate from _smart_list_node_sql", () => {
    // If one grew its own predicate builder, the preview would promise a
    // number the Leads page and the dialer would not agree with.
    for (const signature of [
      "create or replace function public.leads_matching_filter(in_recipe jsonb)",
      "create or replace function public.leads_matching_filter_rows(in_recipe jsonb)",
    ]) {
      const sql = latestDefining(signature);
      const body = sql.slice(sql.indexOf(signature));
      expect(body, signature).toContain(
        "public._smart_list_node_sql(in_recipe)",
      );
    }
  });

  it("the countable one returns setof leads, and both run as the caller", () => {
    const rows = latestDefining(
      "create or replace function public.leads_matching_filter_rows(in_recipe jsonb)",
    );
    const body = rows.slice(
      rows.indexOf(
        "create or replace function public.leads_matching_filter_rows(in_recipe jsonb)",
      ),
    );
    expect(body).toMatch(/returns setof public\.leads/);
    // SECURITY INVOKER matters twice over here: it is what scopes the count to
    // the caller's own leads, and what keeps the preview equal to what that
    // person's dialer will actually see.
    expect(body).toMatch(/security invoker/);
    expect(body).not.toMatch(/security definer/);
  });
});
