import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CONNECTED_OUTCOMES } from "../src/lib/calls/outcomes";

/**
 * The smart-list "connected" condition is evaluated in SQL by
 * _smart_list_node_sql(), which carries its own copy of the outcome list. It
 * drifted once (missing gatekeeper_not_interested and hung_up_later, still
 * counting ai_error). This test reads the constant out of the newest
 * migration that defines the function and asserts it is exactly
 * CONNECTED_OUTCOMES, so the two cannot drift again without a red build.
 */

const MIGRATIONS = "supabase/migrations";
const DEFINES = "create or replace function public._smart_list_node_sql(";

function read(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

/** The most recent migration that (re)defines _smart_list_node_sql. */
function latestDefinition(): { file: string; sql: string } {
  const dir = fileURLToPath(new URL(`../${MIGRATIONS}`, import.meta.url));
  const file = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .reverse()
    .find((f) => read(`${MIGRATIONS}/${f}`).includes(DEFINES));
  if (!file) throw new Error("no migration defines _smart_list_node_sql");
  return { file, sql: read(`${MIGRATIONS}/${file}`) };
}

/** The outcome names inside `connected_in constant text := '(...)';`. */
function sqlConnectedOutcomes(sql: string): string[] {
  const m = /connected_in\s+constant\s+text\s*:=\s*([\s\S]*?\)';)/i.exec(sql);
  if (!m) throw new Error("connected_in constant not found");
  // Inside a SQL string literal each outcome is doubled-quoted: ''goal_met''.
  return [...m[1].matchAll(/''([a-z_]+)''/g)].map((x) => x[1]);
}

describe("_smart_list_node_sql connected list mirrors CONNECTED_OUTCOMES", () => {
  const { file, sql } = latestDefinition();
  const inSql = sqlConnectedOutcomes(sql);

  it(`is defined most recently in ${file}`, () => {
    expect(file >= "20260905221000").toBe(true);
  });

  it("has no duplicates", () => {
    expect(new Set(inSql).size).toBe(inSql.length);
  });

  it("equals the TypeScript set exactly", () => {
    expect(new Set(inSql)).toEqual(CONNECTED_OUTCOMES);
  });

  it("includes the two outcomes the old copy was missing", () => {
    expect(inSql).toContain("gatekeeper_not_interested");
    expect(inSql).toContain("hung_up_later");
  });

  it("no longer counts our own ai_error as a connect", () => {
    expect(inSql).not.toContain("ai_error");
    expect(CONNECTED_OUTCOMES.has("ai_error")).toBe(false);
  });

  it("uses the list for both the true and false branches of `connected`", () => {
    const uses =
      sql.match(/c\.outcome in ' \|\| connected_in \|\| '\)'/g) ?? [];
    expect(uses).toHaveLength(2);
  });
});
