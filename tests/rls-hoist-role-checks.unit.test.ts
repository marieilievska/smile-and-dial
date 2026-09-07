// tests/rls-hoist-role-checks.unit.test.ts
//
// 20260907140000 rewrites eight RLS policies on the three tables where the
// per-row role check was measurably expensive. It is meant to be a PURE
// performance change: every predicate identical to the one it replaces except
// that `public.is_admin(X)` becomes `(select public.is_admin(X))`.
//
// That distinction matters more than usual. A mistake in a policy predicate
// does not make a page slow or throw — it makes one owner's rows visible to
// another, quietly. So rather than eyeballing eight predicates, this
// normalises the role-function calls to a placeholder on both sides and
// asserts the resulting text is character-for-character the same as the
// definition it supersedes.
//
// Live behaviour is checked separately by `npm run smoke:roles`, which signs
// in as all three real accounts and counts what each can actually see.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATIONS = "supabase/migrations";
const NEW = "20260907140000_rls_hoist_role_checks.sql";

function read(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

function files(): string[] {
  return readdirSync(
    fileURLToPath(new URL(`../${MIGRATIONS}`, import.meta.url)),
  )
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/**
 * The text of `create policy "<name>" …;` in one migration, comments dropped.
 *
 * The statement ends at the first `;` sitting OUTSIDE every parenthesis.
 * Matching a literal `\n);` instead looks like it works and does not: these
 * policies close on an indented `  );`, so the search runs on to some later
 * unindented one and swallows whole functions in between — which is exactly
 * what the first version of this test did, and why it failed.
 */
function policyIn(sql: string, name: string): string | null {
  const start = sql.indexOf(`create policy "${name}"`);
  if (start === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === ";" && depth === 0) {
      end = i + 1;
      break;
    }
  }
  const body = sql.slice(start, end === -1 ? undefined : end);
  return body
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
}

/** The definition of `name` in the last migration BEFORE the new one. */
function previousDefinition(name: string): string {
  const earlier = files().filter((f) => f < NEW);
  for (const f of [...earlier].reverse()) {
    const hit = policyIn(read(`${MIGRATIONS}/${f}`), name);
    if (hit) return hit;
  }
  throw new Error(`no earlier migration defines policy ${name}`);
}

/**
 * Collapse the two forms of a role check to one token, so the only thing the
 * comparison can still see is a REAL difference in the predicate.
 *
 * Both `public.is_admin((select auth.uid()))` and its wrapped form become
 * `<ROLE>`, and all whitespace is squeezed.
 */
function normalise(sql: string): string {
  return sql
    .replace(
      /\(\s*select\s+public\.(is_admin|is_super_admin|can_manage_users)\(\s*\(\s*select\s+auth\.uid\(\)\s*\)\s*\)\s*\)/g,
      "<ROLE:$1>",
    )
    .replace(
      /public\.(is_admin|is_super_admin|can_manage_users)\(\s*\(\s*select\s+auth\.uid\(\)\s*\)\s*\)/g,
      "<ROLE:$1>",
    )
    .replace(/\s+/g, " ")
    .trim();
}

const sql = read(`${MIGRATIONS}/${NEW}`);

const REWRITTEN = [
  "leads_select",
  "leads_insert",
  "leads_update",
  "leads_delete",
  "calls_select",
  "calls_insert",
  "calls_update",
  "lead_custom_values_all",
];

describe("every rewritten policy is the old one plus the subquery wrapper", () => {
  it.each(REWRITTEN)("%s is otherwise unchanged", (name) => {
    const before = policyIn(previousDefinition(name), name);
    const after = policyIn(sql, name);
    expect(after, `${name} missing from ${NEW}`).not.toBeNull();
    expect(normalise(after!)).toBe(normalise(before!));
  });

  it("rewrites exactly these eight and no others", () => {
    const created = [...sql.matchAll(/create policy "([a-z_]+)"/g)].map(
      (m) => m[1],
    );
    expect([...created].sort()).toEqual([...REWRITTEN].sort());
    // Every create is paired with the drop that precedes it, so re-running the
    // migration is safe and no policy is left doubled up. Compared in ORDER,
    // against the unsorted list — `.sort()` mutates in place, and sorting
    // `created` first is how this assertion silently stopped checking order.
    const dropped = [...sql.matchAll(/drop policy if exists "([a-z_]+)"/g)].map(
      (m) => m[1],
    );
    expect(dropped).toEqual(created);
  });
});

describe("no role check is left unwrapped in the new file", () => {
  it("every is_admin / can_manage_users call sits inside a scalar subquery", () => {
    const body = sql
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    // Any occurrence NOT preceded by `(select ` is the bug this migration exists
    // to remove.
    const unwrapped = [
      ...body.matchAll(
        /(.{9})public\.(is_admin|can_manage_users|is_super_admin)\(/g,
      ),
    ].filter((m) => !/\(select $/.test(m[1]));
    expect(unwrapped.map((m) => m[0])).toEqual([]);
  });
});

describe("the tiers still mean what roles.ts says they mean", () => {
  it("leads_update keeps the can_manage_users branch in WITH CHECK only", () => {
    const p = policyIn(sql, "leads_update")!;
    const withCheck = p.slice(p.indexOf("with check"));
    const using = p.slice(0, p.indexOf("with check"));
    // Handing a lead to someone else is an admin-tier power (WITH CHECK);
    // reaching a lead you do not own is not (USING).
    expect(withCheck).toContain("can_manage_users");
    expect(using).not.toContain("can_manage_users");
  });

  it("still scopes every table by owner, not by role alone", () => {
    for (const name of REWRITTEN) {
      expect(policyIn(sql, name)!, `${name} lost its owner check`).toMatch(
        /owner_id = \(select auth\.uid\(\)\)/,
      );
    }
  });
});
