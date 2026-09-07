import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every `.range()` read must carry an `.order()`.
 *
 * Postgres guarantees NOTHING about row order across separate LIMIT/OFFSET
 * queries. A pager without a deterministic order can hand the same row to two
 * pages and never return another one — silently, with no error, and only when
 * the database is busy enough for it to matter. Measured on production
 * 2026-09-07 against `calls` (7,798 rows, 8 pages), four page loads at once:
 *
 *     run 1: fetched=7798 distinct=5431 duplicates=2367
 *     run 2: fetched=7798 distinct=5872 duplicates=1926
 *     run 3: fetched=7798 distinct=4852 duplicates=2946
 *     run 4: fetched=7798 distinct=5545 duplicates=2253
 *
 * Run one at a time the SAME pager was flawless on every attempt, which is
 * exactly why three of these shipped and survived review. A reviewer cannot see
 * this and a manual check will not reproduce it, so it is checked here instead.
 * `scripts/verify-pager-stability.mjs` demonstrates it against production.
 *
 * Why a source scan rather than a guard inside fetchAllRows(): all three of the
 * defects this was written for were hand-rolled `for` loops that never called
 * that helper. Every site that DID use it was already correct — its docstring
 * has demanded an order all along. A runtime check inside the helper would have
 * caught none of them, so the check has to look at the source instead.
 *
 * Deliberately narrow: this asserts an `.order()` is PRESENT, not that it is
 * unique. Ordering by a non-unique column (`created_at` alone, `et_day` alone)
 * still lets rows tied on that key reorder across a page boundary — a real but
 * much smaller defect, tracked separately rather than enforced here, so this
 * test stays free of judgement calls about which columns are unique enough.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const MIGRATIONS = fileURLToPath(
  new URL("../supabase/migrations", import.meta.url),
);

/**
 * Pagers whose order comes from somewhere this scan cannot see. Each entry
 * names WHERE the order actually lives; the test below then proves that claim
 * still holds, so an exception cannot quietly rot into a real defect.
 */
const ORDERED_ELSEWHERE: Record<string, string> = {
  "lib/smart-lists/resolve.ts":
    "leads_matching_filter returns `setof uuid`, whose PostgREST column is not " +
    "addressable (`column leads_matching_filter.leads_matching_filter does not " +
    "exist`), so the client CANNOT order it. The `order by l.id` lives in the " +
    "function body — migration 20260907150000.",
};

/**
 * Blank out comments so a `.range(` written in prose (fetch-all-rows.ts
 * documents the rule in its own docstring) is not mistaken for a call. Tracks
 * string and template literals so a `//` inside a URL is left alone. Replaces
 * with spaces rather than deleting, to keep line numbers honest.
 */
function stripComments(src: string): string {
  const out = src.split("");
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) i += src[i] === "\\" ? 2 : 1;
      i++;
    } else if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") out[i++] = " ";
    } else if (ch === "/" && next === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i++;
      }
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
    } else i++;
  }
  return out.join("");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

/**
 * Walk backwards from `idx` to the start of the enclosing expression: the first
 * `;`, `{` or unmatched `(`/`[` found at bracket depth zero. Gives the exact
 * query chain rather than a fixed window of lines, so an unrelated `.order()`
 * on a nearby statement cannot mask a missing one.
 */
function enclosingExpression(src: string, idx: number): string {
  let depth = 0;
  for (let i = idx; i >= 0; i--) {
    const ch = src[i];
    if (ch === ")" || ch === "]" || ch === "}") depth++;
    else if (ch === "(" || ch === "[" || ch === "{") {
      if (depth === 0) return src.slice(i + 1, idx);
      depth--;
    } else if (ch === ";" && depth === 0) return src.slice(i + 1, idx);
  }
  return src.slice(0, idx);
}

/** `query.range(…)` / `return q.range(…)` → the builder variable name. */
function builderVariable(expr: string): string | null {
  return (
    /([A-Za-z_$][\w$]*)\s*$/.exec(expr.replace(/\s*\.\s*$/, ""))?.[1] ?? null
  );
}

/** Every statement in the file that assigns to `name`, joined. */
function assignmentsTo(src: string, name: string): string {
  const out: string[] = [];
  const re = new RegExp(`\\b${name}\\s*=`, "g");
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const end = src.indexOf(";", m.index);
    out.push(src.slice(m.index, end === -1 ? src.length : end));
  }
  return out.join("\n");
}

function unorderedPagers(): string[] {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = file.slice(SRC.length + 1).replace(/\\/g, "/");
    if (rel in ORDERED_ELSEWHERE) continue;
    const src = stripComments(readFileSync(file, "utf8"));
    const re = /\.range\(/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      const expr = enclosingExpression(src, m.index);
      if (expr.includes(".order(")) continue;

      // Builder assembled across statements (`let q = supabase…; q.range(…)`).
      const name = builderVariable(expr);
      if (name && assignmentsTo(src, name).includes(".order(")) continue;

      offenders.push(`${rel}:${src.slice(0, m.index).split("\n").length}`);
    }
  }
  return offenders;
}

/** Newest migration containing `needle`, comments stripped. */
function latestDefining(needle: string): string {
  const hit = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .reverse()
    .map((f) => readFileSync(`${MIGRATIONS}/${f}`, "utf8"))
    .find((sql) => sql.includes(needle));
  if (!hit) throw new Error(`no migration defines ${needle}`);
  return hit.replace(/--[^\n]*/g, "");
}

describe("paged reads are deterministically ordered", () => {
  it("finds the .range() call sites at all (the scan itself works)", () => {
    // A regex that silently matches nothing would make the guard below pass
    // forever. Pin that it is really reading the source.
    const files = sourceFiles(SRC);
    const total = files.reduce(
      (n, f) => n + (readFileSync(f, "utf8").match(/\.range\(/g)?.length ?? 0),
      0,
    );
    expect(files.length).toBeGreaterThan(100);
    expect(total).toBeGreaterThan(20);
  });

  it("catches a chain whose .order() belongs to a different statement", () => {
    // The walk stops at the `;`, so the decoy order must not rescue the pager.
    const decoy =
      'const a = supabase.from("x").order("id").select();\n' +
      'const b = supabase.from("y").select().range(0, 999);';
    const idx = decoy.indexOf(".range(");
    expect(enclosingExpression(decoy, idx)).not.toContain(".order(");
  });

  it("ignores a .range( that only appears in a comment", () => {
    const doc = "// put .range(from, to) at the END\nconst x = 1;";
    expect(stripComments(doc)).not.toContain(".range(");
    // …but not one inside a string, which is still code.
    expect(stripComments('const u = "https://x/y"; q.range(0, 9);')).toContain(
      ".range(",
    );
  });

  it("every .range() call site carries an .order()", () => {
    expect(unorderedPagers()).toEqual([]);
  });

  // The one exception above claims the order lives in SQL instead. Prove it, so
  // a later migration that recreates the function from the pre-2026-09-07 copy
  // fails here rather than silently resuming the duplicate-and-drop behaviour.
  it("keeps the promise made by the ORDERED_ELSEWHERE exception", () => {
    expect(Object.keys(ORDERED_ELSEWHERE)).toEqual([
      "lib/smart-lists/resolve.ts",
    ]);
    const sql = latestDefining(
      "create or replace function public.leads_matching_filter(in_recipe jsonb)",
    );
    expect(sql).toContain("order by l.id");
  });
});
