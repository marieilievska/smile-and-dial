import { readdirSync, readFileSync } from "node:fs";
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
 * An `.order()` is necessary but not sufficient: the order must also be TOTAL.
 * Ordering by a non-unique column (`created_at` alone, `et_day` alone) still
 * leaves rows tied on that key free to swap across a page boundary — the same
 * defect in a smaller costume. So each pager must order by something unique for
 * its table: `id` normally, or every column of the composite key in UNIQUE_KEY.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const MIGRATIONS = fileURLToPath(
  new URL("../supabase/migrations", import.meta.url),
);

/**
 * Pagers whose order comes from somewhere this scan cannot see. Each entry
 * names WHERE the order actually lives; the test below then proves that claim
 * still holds, so an exception cannot quietly rot into a real defect.
 *
 * EMPTY, and worth keeping that way. The only entry was `runFilterRpc` in
 * lib/smart-lists/resolve.ts, which paged `leads_matching_filter` — a
 * `setof uuid`, whose PostgREST column is not addressable, so the client could
 * not order it and the `order by l.id` had to live in the function body. That
 * pager was deleted outright once nothing needed a list of ids in JavaScript:
 * the Leads page applies the recipe DB-side and the campaign preview counts
 * with `count=exact`. An exception you can delete beats one you have to
 * justify.
 */
const ORDERED_ELSEWHERE: Record<string, string> = {};

/**
 * Tables whose unique key is NOT `id`. Every listed column must appear in the
 * pager's `.order()` chain for the sequence to be total. Anything absent here
 * is assumed to have a plain `id`, which every other paged table does.
 */
const UNIQUE_KEY: Record<string, string[]> = {
  // No `id` column at all — one row per day/campaign/list/owner.
  // cost_rollup_daily_grain_idx, migration 20260905181000.
  cost_rollup_daily: ["et_day", "campaign_id", "list_id", "owner_id"],
  // primary key (twilio_number_id, day), migration 20260727180000.
  twilio_number_daily_stats: ["twilio_number_id", "day"],
};
const DEFAULT_KEY = ["id"];

/** The table a query chain reads, from its `.from("…")`. */
function tableOf(chain: string): string | null {
  const hits = [...chain.matchAll(/\.from\(\s*["'`]([^"'`]+)["'`]/g)];
  return hits.length ? hits[hits.length - 1][1] : null;
}

/** Column names passed as string literals to `.order()` in this chain. */
function orderedColumns(chain: string): string[] {
  return [...chain.matchAll(/\.order\(\s*["'`]([^"'`]+)["'`]/g)].map(
    (m) => m[1],
  );
}

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
  // withFileTypes rather than a statSync per entry: same answer, a third of the
  // syscalls, and this walks all 531 files under src/.
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/**
 * Every source file, read and comment-stripped ONCE.
 *
 * The scan reads ~3.1 MB across 531 files, and reading is most of its cost.
 * Doing that per test pushed this file past vitest's 5-second per-test timeout
 * whenever the suite ran with enough workers to contend for the disk — it
 * passed alone and failed about one full run in three. A guard that has to be
 * re-run until it goes green is a guard people learn to ignore, so it is read
 * once and shared.
 */
type Source = { rel: string; raw: string; stripped: string };
let sourceCache: Source[] | null = null;
function allSources(): Source[] {
  if (sourceCache) return sourceCache;
  sourceCache = sourceFiles(SRC).map((file) => {
    const raw = readFileSync(file, "utf8");
    return {
      rel: file.slice(SRC.length + 1).replace(/\\/g, "/"),
      raw,
      stripped: stripComments(raw),
    };
  });
  return sourceCache;
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

/**
 * A `.range(0, …)` fetches ONE page, so it has no page boundary to lose rows
 * across — it can only truncate. A `.range(offset, …)` / `.range(from, to)`
 * resumes from somewhere, and that is what needs a total order. Deciding on the
 * START argument is exact, where "is there a `for` loop nearby" is a guess.
 */
function isPaged(src: string, rangeIdx: number): boolean {
  const args = src.slice(rangeIdx + ".range(".length, rangeIdx + 200);
  return !/^\s*0\s*,/.test(args);
}

function badPagers(): string[] {
  const offenders: string[] = [];
  for (const { rel, stripped: src } of allSources()) {
    if (rel in ORDERED_ELSEWHERE) continue;
    const re = /\.range\(/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      const expr = enclosingExpression(src, m.index);
      // Builder assembled across statements (`let q = supabase…; q.range(…)`).
      const name = builderVariable(expr);
      const chain =
        expr.includes(".order(") || !name
          ? expr
          : `${expr}\n${assignmentsTo(src, name)}`;
      const at = `${rel}:${src.slice(0, m.index).split("\n").length}`;

      if (!chain.includes(".order(")) {
        offenders.push(`${at}  no .order() at all`);
        continue;
      }
      if (!isPaged(src, m.index)) continue; // single page: cannot overlap

      const cols = orderedColumns(chain);
      // `.order(sortVariable)` is not a literal and cannot be checked; those
      // chains pin `id` as the tiebreaker, which is what matters.
      const key = UNIQUE_KEY[tableOf(chain) ?? ""] ?? DEFAULT_KEY;
      const missing = key.filter((k) => !cols.includes(k));
      if (missing.length)
        offenders.push(
          `${at}  ordered by [${cols.join(", ")}] — not unique, missing [${missing.join(", ")}]`,
        );
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
    const files = allSources();
    const total = files.reduce(
      (n, f) => n + (f.raw.match(/\.range\(/g)?.length ?? 0),
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

  it("tells a resumed page from a single first page", () => {
    // Only a pager that RESUMES can lose rows across a boundary.
    const paged = "q.range(from, to); q.range(offset, offset + PAGE - 1);";
    expect(isPaged(paged, paged.indexOf(".range("))).toBe(true);
    expect(isPaged(paged, paged.lastIndexOf(".range("))).toBe(true);
    const once = "q.range(0, EXPORT_LIMIT - 1);";
    expect(isPaged(once, once.indexOf(".range("))).toBe(false);
  });

  it("every .range() carries an .order(), and every pager a UNIQUE one", () => {
    expect(badPagers()).toEqual([]);
  });

  // The one exception above claims the order lives in SQL instead. Prove it, so
  // a later migration that recreates the function from the pre-2026-09-07 copy
  // fails here rather than silently resuming the duplicate-and-drop behaviour.
  it("carries no exceptions at all", () => {
    // The single entry was deleted with the pager that needed it. Adding one
    // back means adding a test beside it that proves its claim, the way the
    // one below still proves the SQL half of the old one.
    expect(Object.keys(ORDERED_ELSEWHERE)).toEqual([]);
  });

  // leads_matching_filter is no longer paged by anything, but refresh_smart_list
  // still reads it and a future caller could page it again. Keep the order by
  // pinned so recreating the function from a pre-2026-09-07 copy fails here
  // rather than silently resuming the duplicate-and-drop behaviour.
  it("keeps the order by inside leads_matching_filter", () => {
    const sql = latestDefining(
      "create or replace function public.leads_matching_filter(in_recipe jsonb)",
    );
    expect(sql).toContain("order by l.id");
  });
});
