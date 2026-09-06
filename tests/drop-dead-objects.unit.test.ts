import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * Guard for the dead-object drop (20260905230000).
 *
 * Pins WHAT the migration drops (so a rebase or re-run can't quietly lose a
 * statement), that every drop is guarded with IF EXISTS, that the rebuilt
 * calls.outcome CHECK is the previous list minus exactly `dm_reached` — and,
 * most importantly, what it must NOT touch: the objects live features still
 * depend on.
 */

const MIGRATIONS = "supabase/migrations";
const DROP = "20260905230000_drop_dead_objects.sql";
const PREVIOUS_OUTCOME_CHECK =
  "20260811170000_add_gatekeeper_not_interested_outcome.sql";

function read(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

/** Drop `-- ...` comment lines so prose about an object is never parsed as a
 *  statement. */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

/** Statements, whitespace-normalised, lower-cased, without the trailing `;`. */
function statements(sql: string): string[] {
  return stripComments(sql)
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);
}

/** The quoted values inside `outcome in (...)` of a calls_outcome_check. */
function outcomeValues(sql: string): string[] {
  const m = stripComments(sql).match(/outcome\s+in\s*\(([\s\S]*?)\)/i);
  if (!m) throw new Error("no calls_outcome_check list found");
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

const sql = read(`${MIGRATIONS}/${DROP}`);
const code = stripComments(sql);
const stmts = statements(sql);

describe("20260905230000_drop_dead_objects", () => {
  it("drops the hot_lead_dismissals table and its policy", () => {
    expect(stmts).toContain(
      'drop policy if exists "admins read hot_lead_dismissals" on public.hot_lead_dismissals',
    );
    expect(stmts).toContain("drop table if exists public.hot_lead_dismissals");
  });

  it("drops the voice-id RPC and the app_settings column behind it", () => {
    expect(stmts).toContain(
      "drop function if exists public.elevenlabs_voice_ids()",
    );
    expect(stmts).toContain(
      "alter table public.app_settings drop column if exists elevenlabs_voice_ids",
    );
  });

  it("drops ONLY the 3-arg is_within_calling_hours overload", () => {
    expect(stmts).toContain(
      "drop function if exists public.is_within_calling_hours(text, time, time)",
    );
    // The live 4-arg (allow_weekends) overload must survive.
    expect(code).not.toMatch(
      /drop\s+function[^;]*is_within_calling_hours\s*\(\s*text\s*,\s*time\s*,\s*time\s*,\s*boolean\s*\)/i,
    );
  });

  it("drops the seven dead columns", () => {
    for (const [table, column] of [
      ["calls", "theme"],
      ["calls", "suggested_action"],
      ["profiles", "notify_on_goal_met"],
      ["profiles", "notify_on_email_reply"],
      ["profiles", "avatar_url"],
      ["profiles", "last_login_at"],
      ["leads", "utm_campaign"],
    ]) {
      expect(stmts).toContain(
        `alter table public.${table} drop column if exists ${column}`,
      );
    }
  });

  it("drops the three unused indexes", () => {
    for (const idx of [
      "idx_leads_dial_eligible",
      "calls_local_match_idx",
      "calls_dest_country_idx",
    ]) {
      expect(stmts).toContain(`drop index if exists public.${idx}`);
    }
  });

  it("rebuilds calls_outcome_check as the previous list minus dm_reached", () => {
    expect(stmts).toContain(
      "alter table public.calls drop constraint if exists calls_outcome_check",
    );
    const previous = outcomeValues(
      read(`${MIGRATIONS}/${PREVIOUS_OUTCOME_CHECK}`),
    );
    const next = outcomeValues(sql);
    expect(previous).toContain("dm_reached");
    expect(next).not.toContain("dm_reached");
    expect(next).toEqual(previous.filter((v) => v !== "dm_reached"));
    // The rebuilt constraint keeps NULL allowed.
    expect(code).toMatch(/check\s*\(\s*outcome is null\s+or outcome in/i);
  });

  it("guards every drop with IF EXISTS", () => {
    const drops = stmts.filter(
      (s) => s.startsWith("drop ") || / drop (column|constraint) /.test(s),
    );
    expect(drops.length).toBeGreaterThan(0);
    for (const s of drops) expect(s, s).toContain("if exists");
  });

  it("leaves the protected objects alone", () => {
    // A knowledge-base sync feature is being built on this column.
    expect(code).not.toMatch(/elevenlabs_kb_id/i);
    // Smart lists need this index.
    expect(code).not.toMatch(/smart_list_members_lead_idx/i);
    // Still written by monitor_twilio_connect_rates.
    expect(code).not.toMatch(/last_connect_rate_check_at/i);
    // leads.status and its CHECK are out of scope.
    expect(code).not.toMatch(
      /alter\s+table\s+public\.leads\s+drop\s+constraint/i,
    );
    expect(code).not.toMatch(/leads_status_check/i);
    // No table other than hot_lead_dismissals is dropped.
    const tableDrops = stmts.filter((s) => s.startsWith("drop table"));
    expect(tableDrops).toEqual([
      "drop table if exists public.hot_lead_dismissals",
    ]);
  });

  it("grants nothing (the EXECUTE lock-down stays intact)", () => {
    expect(code).not.toMatch(/\bgrant\b/i);
  });
});
