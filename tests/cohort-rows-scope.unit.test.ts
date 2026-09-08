import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards for cohort_rows' campaign scoping (20260908100000).
 *
 * The Reporting > Daily tab joins two per-day sources in one row:
 * `reporting_daily_kpis`, which has always taken campaign ids, and
 * `cohort_rows`, which did not. Narrowed to one campaign, that campaign's calls
 * sat beside WORKSPACE-WIDE registrations and spend and every $/reg on the page
 * was divided by the wrong denominator.
 *
 * The failure mode these tests exist for is not an error — it is a plausible
 * number. Scope two of the three CTEs and nothing breaks, nothing raises, and
 * the page reads a cost per registration that is quietly wrong. So all three
 * are asserted separately, by name.
 */

const MIGRATIONS = "supabase/migrations";

function read(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

/** Drop `-- ...` comments so prose about the design never matches. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Newest migration that (re)defines `needle`, comments stripped. */
function latestDefining(needle: string): string {
  const dir = fileURLToPath(new URL(`../${MIGRATIONS}`, import.meta.url));
  const hit = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .reverse()
    .map((f) => read(`${MIGRATIONS}/${f}`))
    .find((s) => s.includes(needle));
  if (!hit) throw new Error(`no migration defines ${needle}`);
  return stripComments(hit);
}

// RESOLVED, not pinned by hand: this function is dropped and recreated whole
// whenever its signature changes, so a hard-coded filename would go stale on
// the next such migration and these guards would then be pinning a definition
// that is no longer live.
//
// The needle ends at the open paren and a newline because the signature is
// multi-line. It matches neither the one-line DROP nor the grant and comment,
// which all put `(date, date, uuid[])` on a single line.
const sql = latestDefining("function public.cohort_rows(\n");

/**
 * One named CTE's body: from `<name> as (` to its OWN closing paren at the
 * same indent. Bounding each slice by its own close means a CTE inserted in
 * the gap cannot creep into a test that never meant to cover it. The trailing
 * `[,\n]` is what lets this find the LAST CTE too, which closes with `)` and
 * no comma — reg_stats is exactly that one, and it is the subtle filter.
 */
function cte(name: string): string {
  const body = new RegExp(`\\n  ${name} as \\(([\\s\\S]*?)\\n  \\)[,\\n]`).exec(
    sql,
  );
  if (!body) throw new Error(`CTE ${name} not found`);
  return body[1];
}

describe("the campaign parameter replaces the function rather than overloading it", () => {
  it("drops the two-argument version before creating the new one", () => {
    // Adding a parameter changes the function's identity, so CREATE OR REPLACE
    // would leave BOTH versions live and PostgREST would see two overloads.
    const dropped = sql.indexOf(
      "drop function if exists public.cohort_rows(date, date);",
    );
    const created = sql.indexOf("create function public.cohort_rows(");
    expect(dropped, "no drop found").toBeGreaterThanOrEqual(0);
    expect(created).toBeGreaterThan(dropped);
  });

  it("re-issues the grant AFTER the drop, so the new function is reachable", () => {
    // A dropped function is a NEW function and takes none of the old one's
    // privileges. A GRANT written above the DROP would land on the function
    // about to be destroyed, and every signed-in user would get "permission
    // denied for function cohort_rows" instead of a page.
    const dropped = sql.indexOf("drop function if exists public.cohort_rows");
    const granted = sql.indexOf(
      "grant execute on function public.cohort_rows(date, date, uuid[]) to authenticated;",
    );
    expect(granted, "no grant found").toBeGreaterThanOrEqual(0);
    expect(granted).toBeGreaterThan(dropped);
  });

  it("keeps p_campaign_ids optional, so the deployed two-argument call still works", () => {
    // The migration lands before the code that passes three arguments. Without
    // the default, pushing it would break the live page until the deploy.
    expect(sql).toMatch(/p_campaign_ids uuid\[\] default null/);
  });

  it("grants nothing to anon or PUBLIC", () => {
    expect(sql).not.toMatch(/grant execute[^;]*\banon\b/);
    expect(sql).not.toMatch(/grant execute[^;]*\bpublic\b\s*;/);
  });
});

describe("cohort_rows still runs as the caller", () => {
  it("is SECURITY INVOKER, never DEFINER", () => {
    // The one property a drop-and-recreate is most likely to lose. DEFINER
    // here would bypass RLS and show every member every other member's leads,
    // costs and registrations through a report that looks correctly scoped.
    expect(sql).toMatch(/security invoker/);
    expect(sql).not.toMatch(/security definer/);
  });

  it("is stable and pins its search path", () => {
    expect(sql).toMatch(/\bstable\b/);
    expect(sql).toMatch(/set search_path = public/);
  });
});

describe("all three per-day sources are scoped", () => {
  // Scoping two of the three is the dangerous outcome: no error, just a
  // cost-per-registration divided by the wrong denominator. Each is named
  // separately so a miss says which one.
  it("scopes the calls", () => {
    expect(cte("call_stats")).toContain(
      "(p_campaign_ids is null or c.campaign_id = any(p_campaign_ids))",
    );
  });

  it("scopes the spend", () => {
    expect(cte("spend_stats")).toContain(
      "(p_campaign_ids is null or campaign_id = any(p_campaign_ids))",
    );
  });

  it("scopes the registrations", () => {
    expect(cte("reg_stats")).toContain("p_campaign_ids");
  });

  it("lets null mean ALL campaigns in every one of them", () => {
    // The convention p_campaign follows in list_performance. A filter that
    // dropped rows when nothing was selected would empty the default view.
    for (const name of ["call_stats", "spend_stats", "reg_stats"]) {
      expect(cte(name), name).toContain("p_campaign_ids is null");
    }
  });
});

describe("a registration inherits its campaign from the calls to its lead", () => {
  const reg = cte("reg_stats");

  it("scopes through an EXISTS on calls, mirroring list_performance", () => {
    // calendly_events has no campaign column, so there is nothing to filter on
    // directly. Same shape as list_performance's reg_stats, deliberately: two
    // pages attributing a registration to a campaign by different rules is a
    // bug nobody can see.
    expect(reg).toMatch(
      /exists \(\s*select 1\s+from calls c2\s+where c2\.lead_id = ce\.lead_id\s+and c2\.campaign_id = any\(p_campaign_ids\)\s*\)/,
    );
  });

  it("never invents a campaign column on calendly_events", () => {
    expect(reg).not.toMatch(/ce\.campaign_id/);
  });

  it("matches the rule list_performance uses", () => {
    // Compared, not paraphrased. If these two drift, the Cohorts figures and
    // the per-list figures attribute the same registration differently and
    // nobody can tell which page is lying.
    const lp = latestDefining("function public.list_performance(\n");
    const shape =
      /exists\s*\(\s*select 1\s+from calls c2\s+where c2\.lead_id = ce\.lead_id\s+and c2\.campaign_id = /;
    expect(lp).toMatch(shape);
    expect(reg).toMatch(shape);
  });
});
