import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * Guard for the EXECUTE lock-down (20260905170000).
 *
 * Postgres hands EXECUTE on every new function to PUBLIC, and Supabase's
 * default privileges add anon / authenticated on top. Until that migration
 * only merge_campaign had ever been closed, so anyone holding the public anon
 * key could call is_admin, is_phone_on_dnc, pool_number_usage_24h and every
 * SECURITY DEFINER mutator with no login at all.
 *
 * These tests pin the migration's shape (the revoke, the default-privilege
 * revoke, the exact authenticated allow-list, nothing for anon) and fail if a
 * LATER migration quietly grants EXECUTE back to anon or PUBLIC. They also
 * pin merge_inbound_lead's auth.uid() authorisation so a future rewrite from
 * a stale copy can't bring back the "in_actor is null → skip the ownership
 * check" gap.
 */

const MIGRATIONS = "supabase/migrations";
const LOCKDOWN = "20260905170000_lock_down_function_execute.sql";

/** The only functions the app calls with the user-scoped (cookie / RLS)
 *  client, plus the helpers those need. Each has its call site documented
 *  next to the grant in the migration. Adding one here without adding the
 *  grant (or vice versa) fails the test on purpose. */
const AUTHENTICATED_ALLOW_LIST = [
  "public.is_admin(uuid)",
  "public.leads_matching_filter_rows(jsonb)",
  "public.leads_matching_filter(jsonb)",
  "public._smart_list_node_sql(jsonb)",
  "public._smart_list_custom_sql(text, text, jsonb)",
  "public._smart_list_date_sql(text, text, jsonb)",
  "public._smart_list_num_sql(text, text, jsonb)",
  "public._smart_list_text_sql(text, text, jsonb)",
  "public.cohort_rows(date, date)",
  "public.pre_call_check(uuid, uuid)",
  "public.is_phone_on_dnc(text)",
  "public.refresh_smart_list(uuid)",
  "public.merge_inbound_lead(uuid, uuid, jsonb, uuid)",
  "public.set_updated_at()",
];

function read(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

function migrationFiles(): string[] {
  const dir = fileURLToPath(new URL(`../${MIGRATIONS}`, import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** The most recent migration that (re)defines `needle`. */
function latestDefining(needle: string): string {
  const hit = migrationFiles()
    .reverse()
    .find((f) => read(`${MIGRATIONS}/${f}`).includes(needle));
  if (!hit) throw new Error(`no migration defines ${needle}`);
  return read(`${MIGRATIONS}/${hit}`);
}

/** Drop `-- ...` comment lines so prose about grants is never parsed as one. */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

type Grant = { target: string; roles: string[] };

/** Every `grant execute on <target> to <roles>;` in the SQL, comments removed. */
function executeGrants(sql: string): Grant[] {
  const out: Grant[] = [];
  const re = /grant\s+execute\s+on\s+([\s\S]*?)\s+to\s+([^;]+);/gi;
  for (const m of stripComments(sql).matchAll(re)) {
    out.push({
      target: m[1].replace(/\s+/g, " ").trim(),
      roles: m[2].split(",").map((r) => r.trim().toLowerCase()),
    });
  }
  return out;
}

describe("function EXECUTE lock-down migration", () => {
  const sql = read(`${MIGRATIONS}/${LOCKDOWN}`);
  const code = stripComments(sql);

  it("revokes execute on every public function from PUBLIC, anon and authenticated", () => {
    expect(code).toMatch(
      /revoke\s+execute\s+on\s+all\s+functions\s+in\s+schema\s+public\s+from\s+public,\s*anon,\s*authenticated;/i,
    );
  });

  it("closes the default privileges so future functions start locked", () => {
    expect(code).toMatch(
      /alter\s+default\s+privileges\s+for\s+role\s+postgres\s+in\s+schema\s+public\s+revoke\s+execute\s+on\s+functions\s+from\s+public,\s*anon,\s*authenticated;/i,
    );
  });

  it("keeps service_role able to run everything", () => {
    expect(code).toMatch(
      /grant\s+execute\s+on\s+all\s+functions\s+in\s+schema\s+public\s+to\s+service_role;/i,
    );
    expect(code).not.toMatch(/revoke[^;]*from[^;]*\bservice_role\b/i);
  });

  it("grants authenticated exactly the documented allow-list", () => {
    const granted = executeGrants(sql)
      .filter((g) => g.roles.includes("authenticated"))
      .map((g) => g.target.replace(/^function\s+/i, ""));
    expect(new Set(granted)).toEqual(new Set(AUTHENTICATED_ALLOW_LIST));
    expect(granted).toHaveLength(AUTHENTICATED_ALLOW_LIST.length);
  });

  it("grants anon and PUBLIC nothing", () => {
    const open = executeGrants(sql).filter(
      (g) => g.roles.includes("anon") || g.roles.includes("public"),
    );
    expect(open).toEqual([]);
  });

  it("re-grants the auth trigger to supabase_auth_admin", () => {
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.handle_new_user\(\)\s+to\s+supabase_auth_admin/i,
    );
  });
});

describe("no later migration reopens functions to anon or PUBLIC", () => {
  const later = migrationFiles().filter((f) => f > LOCKDOWN);

  it.each(later.length ? later : [""])("%s", (file) => {
    if (!file) return; // nothing after the lock-down yet
    const open = executeGrants(read(`${MIGRATIONS}/${file}`)).filter(
      (g) => g.roles.includes("anon") || g.roles.includes("public"),
    );
    expect(open, `${file} grants EXECUTE to anon/PUBLIC`).toEqual([]);
  });
});

describe("merge_inbound_lead authorises by auth.uid()", () => {
  const def = latestDefining(
    "create or replace function public.merge_inbound_lead(",
  );

  it("keeps the four-argument signature the server action calls", () => {
    expect(def).toMatch(
      /merge_inbound_lead\(\s*in_source_lead_id uuid,\s*in_destination_lead_id uuid,\s*in_patch jsonb,\s*in_actor uuid\s*\)/,
    );
  });

  it("resolves the actor from auth.uid() first, then in_actor", () => {
    expect(def).toMatch(/v_actor\s*:=\s*auth\.uid\(\);/);
    expect(def).toMatch(/if v_actor is null then\s*v_actor := in_actor;/);
  });

  it("refuses when there is no actor at all", () => {
    expect(def).toMatch(
      /if v_actor is null then\s*raise exception 'merge_inbound_lead requires an authenticated caller or an explicit in_actor';/,
    );
  });

  it("always enforces owner-or-admin on the resolved actor", () => {
    expect(def).toMatch(
      /if v_source\.owner_id is distinct from v_actor and not public\.is_admin\(v_actor\) then\s*raise exception 'caller does not own these leads';/,
    );
    // The v2 shape that skipped the check when in_actor was null.
    expect(def).not.toMatch(/if in_actor is not null and v_source\.owner_id/);
  });

  it("records the resolved actor on the audit row", () => {
    expect(def).toMatch(/'lead_merged',\s*v_actor,/);
  });
});
