import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { STANDARD_RUBRIC } from "../src/lib/review/rubric-seed";

const REBUILD_SQL =
  "supabase/migrations/20260719130000_review_rubric_rebuild.sql";

function sql(relPath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${relPath}`, import.meta.url)),
    "utf8",
  );
}

/** Flag keys the migration INSERTs (the first quoted value of each value row). */
function insertedKeys(text: string): string[] {
  const block = text.slice(
    text.indexOf("insert into public.review_flag_defs"),
    text.indexOf("on conflict (key)"),
  );
  return [...block.matchAll(/\(\s*'([a-z0-9_]+)'\s*,/g)].map((m) => m[1]);
}

/** Flag keys the migration RETIRES (the `set active = false ... in (...)` list). */
function retiredKeys(text: string): string[] {
  const start = text.indexOf("set active = false");
  const block = text.slice(start, text.indexOf(");", start));
  return [...block.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
}

describe("STANDARD_RUBRIC self-heal seed", () => {
  it("contains every flag the rebuild migration inserts (no drift)", () => {
    const fromTs = new Set(STANDARD_RUBRIC.map((f) => f.key));
    for (const key of insertedKeys(sql(REBUILD_SQL))) {
      expect(
        fromTs.has(key),
        `${key} is in the migration but not the seed`,
      ).toBe(true);
    }
  });

  it("never re-seeds a retired flag", () => {
    // ensureStandardRubric runs after a prod data wipe. If a retired flag were
    // still listed here it would come back to life and start collecting
    // findings again — which is exactly the mess this rebuild removed.
    const retired = new Set(retiredKeys(sql(REBUILD_SQL)));
    for (const f of STANDARD_RUBRIC) {
      expect(
        retired.has(f.key),
        `${f.key} was retired but is still seeded`,
      ).toBe(false);
    }
  });

  it("has unique keys and includes the always-on catch-alls", () => {
    const keys = STANDARD_RUBRIC.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    // Stamped without an LLM on calls that never reached a human.
    expect(keys).toContain("no_conversation");
    // The single key every per-agent playbook finding is filed under.
    expect(keys).toContain("playbook_missed");
  });

  it("only uses valid lenses and positive severities", () => {
    const lenses = new Set([
      "bug",
      "compliance",
      "quality",
      "opportunity",
      "voc",
    ]);
    for (const f of STANDARD_RUBRIC) {
      expect(lenses.has(f.lens)).toBe(true);
      expect(f.severity).toBeGreaterThanOrEqual(1);
      expect(f.guidance.trim().length).toBeGreaterThan(0);
    }
  });
});
