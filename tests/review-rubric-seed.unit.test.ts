import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { STANDARD_RUBRIC } from "../src/lib/review/rubric-seed";

// Pull every flag key seeded by a migration's `insert into review_flag_defs`.
function migrationKeys(relPath: string): string[] {
  const sql = readFileSync(
    fileURLToPath(new URL(`../${relPath}`, import.meta.url)),
    "utf8",
  );
  // Keys are the first single-quoted value on each `('key', ...` value row.
  return [...sql.matchAll(/\(\s*'([a-z0-9_]+)'\s*,/g)].map((m) => m[1]);
}

describe("STANDARD_RUBRIC self-heal seed", () => {
  it("stays in sync with the SQL migrations (no drift)", () => {
    const fromSql = new Set([
      ...migrationKeys(
        "supabase/migrations/20260714120000_reseed_review_flag_defs.sql",
      ),
      ...migrationKeys(
        "supabase/migrations/20260715140000_call_review_agent_playbook.sql",
      ),
    ]);
    const fromTs = new Set(STANDARD_RUBRIC.map((f) => f.key));
    // Same set both ways — a flag added to a migration but not here (or vice
    // versa) fails the build, which is the whole point of this guard.
    expect([...fromTs].sort()).toEqual([...fromSql].sort());
  });

  it("has unique keys and includes the always-on catch-alls", () => {
    const keys = STANDARD_RUBRIC.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("no_conversation");
    expect(keys).toContain("off_script");
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
