import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * Guards for the member self-service bundle (20260905190000-194000).
 *
 * Five silent no-ops, all the same shape: a cookie-client write hit an
 * admin-only policy, matched zero rows, and the action reported success.
 *
 *   - profiles UPDATE is admin-only, so a member's active campaign and
 *     onboarding stamps never saved -> update_my_profile().
 *   - calendly_events writes were admin-only, so a member's attended/sale
 *     marks never landed and Cohorts counted them as no-shows -> owner
 *     UPDATE policy.
 *   - DNC lists are now per user (no admin branch) while the dialer still
 *     blocks a number on ANY user's list -> owner_id + fill trigger.
 *   - custom fields: everyone uses every field, only the creator changes it
 *     -> created_by + move_custom_field().
 *   - twilio_number_daily_stats was admin-only while the numbers pages are
 *     member-facing -> owner-or-admin SELECT.
 *
 * These pin the migration shapes so a later "cleanup" can't quietly bring an
 * admin gate back, widen the DNC read policy, or add an owner filter to the
 * dial-time DNC check.
 */

const MIGRATIONS = "supabase/migrations";
const PROFILE = "20260905190000_update_my_profile.sql";
const CALENDLY = "20260905191000_calendly_events_owner_update.sql";
const DNC = "20260905192000_dnc_per_user.sql";
const FIELDS = "20260905193000_custom_field_ownership.sql";
const STATS = "20260905194000_number_daily_stats_members.sql";

function read(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${rel}`, import.meta.url)),
    "utf8",
  );
}

/** Drop `-- ...` comments so prose about the old behaviour never matches. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function migration(file: string): string {
  return stripComments(read(`${MIGRATIONS}/${file}`));
}

let allMigrations: string[] | null = null;

/** Every migration's contents, newest first. Read once per run: three
 *  `latestDefining` lookups over ~170 files was enough to trip the 5 s test
 *  timeout on a loaded machine. */
function migrationsNewestFirst(): string[] {
  if (allMigrations) return allMigrations;
  const dir = fileURLToPath(new URL(`../${MIGRATIONS}`, import.meta.url));
  allMigrations = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .reverse()
    .map((f) => read(`${MIGRATIONS}/${f}`));
  return allMigrations;
}

/** The most recent migration that (re)defines `needle`, comments stripped. */
function latestDefining(needle: string): string {
  const hit = migrationsNewestFirst().find((sql) => sql.includes(needle));
  if (!hit) throw new Error(`no migration defines ${needle}`);
  return stripComments(hit);
}

type Grant = { target: string; roles: string[] };

function executeGrants(sql: string): Grant[] {
  const out: Grant[] = [];
  const re = /grant\s+execute\s+on\s+function\s+([\s\S]*?)\s+to\s+([^;]+);/gi;
  for (const m of stripComments(sql).matchAll(re)) {
    out.push({
      target: m[1].replace(/\s+/g, " ").trim(),
      roles: m[2].split(",").map((r) => r.trim().toLowerCase()),
    });
  }
  return out;
}

/** The `create policy "<name>" ... ;` block, comments stripped. */
function policy(sql: string, name: string): string {
  const re = new RegExp(String.raw`create\s+policy\s+"${name}"[\s\S]*?;`, "i");
  const m = re.exec(sql);
  if (!m) throw new Error(`policy ${name} not found`);
  return m[0].replace(/\s+/g, " ");
}

describe("update_my_profile (profiles self-service)", () => {
  const sql = migration(PROFILE);

  it("is SECURITY DEFINER and scoped to the caller's own row", () => {
    expect(sql).toMatch(
      /create or replace function public\.update_my_profile\(patch jsonb\)/,
    );
    expect(sql).toMatch(/security definer/);
    expect(sql).toMatch(/v_uid uuid := auth\.uid\(\);/);
    expect(sql).toMatch(/update public\.profiles[\s\S]*?where id = v_uid;/);
  });

  it("refuses an anonymous caller", () => {
    expect(sql).toMatch(
      /if v_uid is null then\s*raise exception 'update_my_profile requires an authenticated caller';/,
    );
  });

  it("patches only the four self-service columns, never role or active", () => {
    const body = /update public\.profiles([\s\S]*?)where id = v_uid;/.exec(
      sql,
    )![1];
    for (const col of [
      "active_campaign_id",
      "welcome_seen_at",
      "onboarding_dismissed_at",
      "full_name",
    ]) {
      expect(body).toMatch(new RegExp(String.raw`\b${col}\s*=\s*case`));
    }
    expect(body).not.toMatch(/\brole\s*=/);
    expect(body).not.toMatch(/\bactive\s*=/);
  });

  it("checks the active campaign is visible to the caller", () => {
    expect(sql).toMatch(/c\.owner_id = v_uid or public\.is_admin\(v_uid\)/);
  });

  it("is granted to authenticated only", () => {
    const grants = executeGrants(sql);
    expect(grants).toEqual([
      { target: "public.update_my_profile(jsonb)", roles: ["authenticated"] },
    ]);
  });

  it("keeps the admin-only table policy in place (no profiles policy changes)", () => {
    expect(sql).not.toMatch(/create\s+policy/i);
  });
});

describe("calendly_events owner update", () => {
  const sql = migration(CALENDLY);

  it("lets the owner update their registrations, pinned to their own owner_id", () => {
    const p = policy(sql, "calendly_events_owner_update");
    expect(p).toMatch(/for update/);
    expect(p).toMatch(/using \(owner_id = \(select auth\.uid\(\)\)\)/);
    expect(p).toMatch(/with check \(owner_id = \(select auth\.uid\(\)\)\)/);
  });

  it("does not open insert or delete to non-admins", () => {
    expect(sql).not.toMatch(/for\s+(insert|delete|all)/i);
    expect(sql).not.toMatch(/drop\s+policy[^;]*calendly_events_admin_write/i);
  });
});

describe("per-user DNC lists", () => {
  const sql = migration(DNC);

  it("adds owner_id and backfills to the adder, else the oldest admin", () => {
    expect(sql).toMatch(
      /alter table public\.dnc_entries\s+add column if not exists owner_id uuid references auth\.users \(id\) on delete set null;/,
    );
    expect(sql).toMatch(
      /update public\.dnc_entries\s+set owner_id = coalesce\(\s*added_by_user_id,[\s\S]*?where p\.role = 'admin'\s+order by p\.created_at asc\s+limit 1[\s\S]*?where owner_id is null;/,
    );
  });

  it("fills owner_id on insert: explicit, auth.uid(), added_by, lead owner, admin -- in that order", () => {
    const body =
      /function public\.dnc_entries_fill_owner\(\)([\s\S]*?)\$\$;/.exec(
        sql,
      )![1];
    const steps = [
      /if new\.owner_id is not null then\s*return new;/,
      /new\.owner_id := auth\.uid\(\);/,
      /new\.owner_id := new\.added_by_user_id;/,
      /from public\.leads l\s+where l\.business_phone = new\.phone\s+or l\.mobile_phone = new\.phone\s+or l\.owner_phone = new\.phone\s+order by \(l\.deleted_at is null\) desc, l\.updated_at desc\s+limit 1;/,
      /from public\.profiles p\s+where p\.role = 'admin'\s+and p\.active = true\s+order by p\.created_at asc\s+limit 1;/,
    ];
    let last = -1;
    for (const step of steps) {
      const m = step.exec(body);
      expect(m, `missing step ${step}`).not.toBeNull();
      expect(m!.index).toBeGreaterThan(last);
      last = m!.index;
    }
    expect(sql).toMatch(
      /create trigger dnc_entries_fill_owner\s+before insert on public\.dnc_entries\s+for each row\s+execute function public\.dnc_entries_fill_owner\(\);/,
    );
  });

  it("scopes select / insert / delete to the owner with NO admin branch", () => {
    expect(policy(sql, "dnc_entries_select")).toMatch(
      /for select to authenticated using \(owner_id = \(select auth\.uid\(\)\)\);/,
    );
    expect(policy(sql, "dnc_entries_insert")).toMatch(
      /for insert to authenticated with check \(owner_id = \(select auth\.uid\(\)\) or owner_id is null\);/,
    );
    expect(policy(sql, "dnc_entries_delete")).toMatch(
      /for delete to authenticated using \(owner_id = \(select auth\.uid\(\)\)\);/,
    );
    expect(policy(sql, "dnc_removals_select")).toMatch(
      /using \(removed_by_user_id = \(select auth\.uid\(\)\)\);/,
    );
    expect(policy(sql, "dnc_removals_insert")).toMatch(
      /with check \(removed_by_user_id = \(select auth\.uid\(\)\)\);/,
    );
    expect(sql).not.toMatch(/is_admin/);
  });

  it("keeps phone unique workspace-wide until the post-call webhook's onConflict changes", () => {
    expect(sql).not.toMatch(/drop\s+constraint/i);
    expect(sql).not.toMatch(/unique\s*\(\s*owner_id/i);
  });

  it("leaves dial-time enforcement matching on phone alone", () => {
    const queue = latestDefining("create or replace view public.dial_queue");
    expect(queue).toMatch(
      /not exists \(\s*select 1 from public\.dnc_entries d\s+where d\.phone = l\.business_phone\s*\)/,
    );
    const check = latestDefining(
      "create or replace function public.pre_call_check(",
    );
    expect(check).toMatch(
      /select 1 from public\.dnc_entries where phone = v_lead\.business_phone/,
    );
    const helper = latestDefining(
      "create or replace function public.is_phone_on_dnc(",
    );
    expect(helper).toMatch(
      /select 1 from public\.dnc_entries where phone = phone_to_check/,
    );
    for (const def of [queue, check, helper]) {
      const dnc = /from public\.dnc_entries[^)]*\)/.exec(def)![0];
      expect(dnc).not.toMatch(/owner_id/);
    }
  });

  it("grants the trigger function to authenticated only", () => {
    expect(executeGrants(sql)).toEqual([
      {
        target: "public.dnc_entries_fill_owner()",
        roles: ["authenticated"],
      },
    ]);
  });
});

describe("custom field ownership", () => {
  const sql = migration(FIELDS);

  it("adds created_by defaulting to the caller, backfilled to the oldest admin", () => {
    expect(sql).toMatch(
      /add column if not exists created_by uuid\s+references auth\.users \(id\) on delete set null\s+default auth\.uid\(\);/,
    );
    expect(sql).toMatch(
      /update public\.custom_field_defs\s+set created_by = \([\s\S]*?where p\.role = 'admin'\s+order by p\.created_at asc\s+limit 1[\s\S]*?where created_by is null;/,
    );
  });

  it("insert: the caller is the creator", () => {
    expect(policy(sql, "custom_field_defs_insert")).toMatch(
      /with check \(created_by = \(select auth\.uid\(\)\)\);/,
    );
  });

  it("update: the creator, or an admin for a field with no creator", () => {
    const p = policy(sql, "custom_field_defs_update");
    const clause =
      "\\( created_by = \\(select auth\\.uid\\(\\)\\) or \\(created_by is null and public\\.is_admin\\(\\(select auth\\.uid\\(\\)\\)\\)\\) \\)";
    expect(p).toMatch(new RegExp(`using ${clause}`));
    expect(p).toMatch(new RegExp(`with check ${clause}`));
    expect(p).not.toMatch(/using \(true\)/);
  });

  it("delete: the creator or an admin", () => {
    expect(policy(sql, "custom_field_defs_delete")).toMatch(
      /using \( created_by = \(select auth\.uid\(\)\) or public\.is_admin\(\(select auth\.uid\(\)\)\) \);/,
    );
  });

  it("move_custom_field checks the creator before touching the neighbour", () => {
    expect(sql).toMatch(
      /create or replace function public\.move_custom_field\(in_id uuid, in_direction text\)\s+returns text/,
    );
    expect(sql).toMatch(
      /if v_cur\.created_by is distinct from v_uid\s+and not \(v_cur\.created_by is null and public\.is_admin\(v_uid\)\) then\s+return 'not_owner';/,
    );
    for (const outcome of ["moved", "at_edge", "not_owner", "not_found"]) {
      expect(sql).toMatch(new RegExp(`return '${outcome}';`));
    }
    expect(executeGrants(sql)).toEqual([
      {
        target: "public.move_custom_field(uuid, text)",
        roles: ["authenticated"],
      },
    ]);
  });
});

describe("twilio_number_daily_stats select", () => {
  it("is visible to the number's owner or an admin", () => {
    const p = policy(migration(STATS), "twilio_number_daily_stats_select");
    expect(p).toMatch(/for select to authenticated/);
    expect(p).toMatch(
      /exists \( select 1 from public\.twilio_numbers n where n\.id = public\.twilio_number_daily_stats\.twilio_number_id and \( n\.owner_id = \(select auth\.uid\(\)\) or public\.is_admin\(\(select auth\.uid\(\)\)\) \) \)/,
    );
  });
});

describe("nothing in the bundle is granted to anon or PUBLIC", () => {
  it.each([PROFILE, CALENDLY, DNC, FIELDS, STATS])("%s", (file) => {
    const open = executeGrants(read(`${MIGRATIONS}/${file}`)).filter(
      (g) => g.roles.includes("anon") || g.roles.includes("public"),
    );
    expect(open).toEqual([]);
  });
});
