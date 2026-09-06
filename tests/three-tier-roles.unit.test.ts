import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import {
  asAppRole,
  assignableRoles,
  canActOnUser,
  canManageUsers,
  isSuperAdmin,
  ROLE_LABELS,
} from "@/lib/auth/roles";

/**
 * Guards for the three-tier role model (20260906010000).
 *
 * The whole design rests on one substitution: `public.is_admin(uid)` stops
 * meaning "has the admin role" and starts meaning "is the role that sees
 * everything", so the ~84 owner-scoped policies that already read
 * `owner_id = auth.uid() or is_admin(auth.uid())` move to the new model
 * untouched. Elevated POWERS get a separate predicate, `can_manage_users`.
 *
 * These tests pin both halves — the pure TS predicates the UI gates on, and
 * the migration's shape — so a later "cleanup" cannot quietly redefine
 * is_admin back to `role = 'admin'` (which would hand every admin everyone
 * else's leads), drop the self-role or super-admin guards on profiles, or
 * let handle_new_user read a role out of user-supplied metadata again.
 */

const MIGRATIONS = "supabase/migrations";
const ROLES = "20260906010000_three_tier_roles.sql";

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

const sql = stripComments(read(`${MIGRATIONS}/${ROLES}`));
/** Whitespace-flattened, for matching multi-line policy bodies. */
const flat = sql.replace(/\s+/g, " ");

/** The `create policy "<name>" ... ;` block, whitespace flattened. */
function policy(name: string): string {
  const re = new RegExp(String.raw`create policy "${name}"[\s\S]*?;`, "i");
  const m = re.exec(sql);
  if (!m) throw new Error(`policy ${name} not found`);
  return m[0].replace(/\s+/g, " ");
}

type Grant = { target: string; roles: string[] };

function executeGrants(raw: string): Grant[] {
  const out: Grant[] = [];
  const re = /grant\s+execute\s+on\s+function\s+([\s\S]*?)\s+to\s+([^;]+);/gi;
  for (const m of stripComments(raw).matchAll(re)) {
    out.push({
      target: m[1].replace(/\s+/g, " ").trim(),
      roles: m[2].split(",").map((r) => r.trim().toLowerCase()),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The pure predicates the UI gates on.
// ---------------------------------------------------------------------------

describe("role predicates", () => {
  it("treats anything unrecognised as the least-privileged tier", () => {
    expect(asAppRole("super_admin")).toBe("super_admin");
    expect(asAppRole("admin")).toBe("admin");
    expect(asAppRole("member")).toBe("member");
    expect(asAppRole("owner")).toBe("member");
    expect(asAppRole(null)).toBe("member");
    expect(asAppRole(undefined)).toBe("member");
  });

  it("only a super admin sees everything", () => {
    expect(isSuperAdmin("super_admin")).toBe(true);
    expect(isSuperAdmin("admin")).toBe(false);
    expect(isSuperAdmin("member")).toBe(false);
    expect(isSuperAdmin(null)).toBe(false);
  });

  it("both top tiers may manage users", () => {
    expect(canManageUsers("super_admin")).toBe(true);
    expect(canManageUsers("admin")).toBe(true);
    expect(canManageUsers("member")).toBe(false);
    expect(canManageUsers(null)).toBe(false);
  });

  it("only a super admin may hand out the super-admin role", () => {
    expect(assignableRoles("super_admin")).toEqual([
      "super_admin",
      "admin",
      "member",
    ]);
    expect(assignableRoles("admin")).toEqual(["admin", "member"]);
    expect(assignableRoles("member")).toEqual([]);
  });

  it("nobody acts on their own account, and only a super admin on a super admin", () => {
    expect(canActOnUser("super_admin", "member", true)).toBe(false);
    expect(canActOnUser("admin", "member", true)).toBe(false);
    expect(canActOnUser("admin", "member", false)).toBe(true);
    expect(canActOnUser("admin", "admin", false)).toBe(true);
    expect(canActOnUser("admin", "super_admin", false)).toBe(false);
    expect(canActOnUser("super_admin", "super_admin", false)).toBe(true);
    expect(canActOnUser("member", "member", false)).toBe(false);
  });

  it("never renders a raw snake_case role", () => {
    expect(ROLE_LABELS.super_admin).toBe("Super admin");
    expect(ROLE_LABELS.admin).toBe("Admin");
    expect(ROLE_LABELS.member).toBe("Member");
  });
});

// ---------------------------------------------------------------------------
// The migration.
// ---------------------------------------------------------------------------

describe("profiles.role CHECK", () => {
  it("accepts all three tiers and nothing else", () => {
    expect(flat).toMatch(
      /add constraint profiles_role_check check \(role in \('super_admin', 'admin', 'member'\)\)/i,
    );
    expect(sql).toMatch(
      /alter table public\.profiles drop constraint if exists profiles_role_check;/i,
    );
  });
});

describe("is_super_admin", () => {
  it("is the active-super-admin predicate, SECURITY DEFINER with an empty search_path", () => {
    const def =
      /create or replace function public\.is_super_admin\(uid uuid\)([\s\S]*?)\$\$;/
        .exec(sql)![0]
        .replace(/\s+/g, " ");
    expect(def).toMatch(/security definer/);
    expect(def).toMatch(/set search_path = ''/);
    expect(def).toMatch(/from public\.profiles where id = uid/);
    expect(def).toMatch(/and role = 'super_admin'/);
    expect(def).toMatch(/and active = true/);
  });
});

describe("is_admin is a legacy name that delegates to is_super_admin", () => {
  it("returns is_super_admin(uid) and nothing else", () => {
    const def =
      /create or replace function public\.is_admin\(uid uuid\)([\s\S]*?)\$\$;/
        .exec(sql)![0]
        .replace(/\s+/g, " ");
    expect(def).toMatch(/select public\.is_super_admin\(uid\);/);
    // The shape it must never go back to.
    expect(def).not.toMatch(/role = 'admin'/);
  });

  it("says loudly in a comment what it now means", () => {
    const comment = /comment on function public\.is_admin\(uuid\) is([\s\S]*?);/
      .exec(sql)![0]
      .replace(/\s+/g, " ");
    expect(comment).toMatch(/LEGACY NAME/);
    expect(comment).toMatch(/is_super_admin\(uid\)/);
    expect(comment).toMatch(/can_manage_users\(uid\)/);
  });
});

describe("can_manage_users", () => {
  it("covers both top tiers, active only", () => {
    const def =
      /create or replace function public\.can_manage_users\(uid uuid\)([\s\S]*?)\$\$;/
        .exec(sql)![0]
        .replace(/\s+/g, " ");
    expect(def).toMatch(/security definer/);
    expect(def).toMatch(/set search_path = ''/);
    expect(def).toMatch(/role in \('admin', 'super_admin'\)/);
    expect(def).toMatch(/and active = true/);
  });
});

describe("execute grants", () => {
  it("grants all three predicates to authenticated, and nothing to anon or PUBLIC", () => {
    const grants = executeGrants(read(`${MIGRATIONS}/${ROLES}`));
    expect(new Set(grants.map((g) => g.target))).toEqual(
      new Set([
        "public.is_super_admin(uuid)",
        "public.is_admin(uuid)",
        "public.can_manage_users(uuid)",
      ]),
    );
    for (const g of grants) expect(g.roles).toEqual(["authenticated"]);
    expect(
      grants.filter(
        (g) => g.roles.includes("anon") || g.roles.includes("public"),
      ),
    ).toEqual([]);
  });
});

describe("profiles policies", () => {
  it("lets the admin tier list teammates, everyone else only themselves", () => {
    expect(policy("profiles_select")).toMatch(
      /using \( id = \(select auth\.uid\(\)\) or public\.can_manage_users\(\(select auth\.uid\(\)\)\) \);/,
    );
  });

  it("insert: admin tier only, and only a super admin may mint a super admin", () => {
    const p = policy("profiles_insert");
    expect(p).toMatch(/public\.can_manage_users\(\(select auth\.uid\(\)\)\)/);
    expect(p).toMatch(
      /and \(role <> 'super_admin' or public\.is_super_admin\(\(select auth\.uid\(\)\)\)\)/,
    );
  });

  it.each(["profiles_update", "profiles_delete"])(
    "%s: admin tier, never your own row, never a super admin unless you are one",
    (name) => {
      const p = policy(name);
      expect(p).toMatch(/public\.can_manage_users\(\(select auth\.uid\(\)\)\)/);
      // Nobody may change their own role: self-writes go through
      // update_my_profile(), which cannot touch role or active.
      expect(p).toMatch(/and id <> \(select auth\.uid\(\)\)/);
      expect(p).toMatch(
        /and \(role <> 'super_admin' or public\.is_super_admin\(\(select auth\.uid\(\)\)\)\)/,
      );
      expect(p).not.toMatch(/using \(public\.is_admin/);
    },
  );

  it("guards both the existing row and the resulting row on update", () => {
    const p = policy("profiles_update");
    expect(p.match(/id <> \(select auth\.uid\(\)\)/g)).toHaveLength(2);
    expect(p.match(/role <> 'super_admin'/g)).toHaveLength(2);
  });

  it("leaves update_my_profile alone so self-service still works for every role", () => {
    expect(sql).not.toMatch(/update_my_profile/);
    const selfService = read(
      `${MIGRATIONS}/20260905190000_update_my_profile.sql`,
    );
    expect(selfService).toMatch(/security definer/);
  });
});

describe("agent_templates write is an admin-tier power", () => {
  it("uses can_manage_users, not is_admin", () => {
    const p = policy("agent_templates_write");
    expect(p).toMatch(
      /using \(public\.can_manage_users\(\(select auth\.uid\(\)\)\)\)/,
    );
    expect(p).toMatch(
      /with check \(public\.can_manage_users\(\(select auth\.uid\(\)\)\)\)/,
    );
    expect(p).not.toMatch(/is_admin/);
  });

  it("does not touch the read policy — the shelf stays shared", () => {
    expect(sql).not.toMatch(/agent_templates_select/);
  });
});

describe("leads hand-over", () => {
  it("widens only WITH CHECK, so an admin can give away a lead but not take one", () => {
    const p = policy("leads_update");
    expect(p).toMatch(
      /using \( owner_id = \(select auth\.uid\(\)\) or public\.is_admin\(\(select auth\.uid\(\)\)\) \)/,
    );
    expect(p).toMatch(
      /with check \( owner_id = \(select auth\.uid\(\)\) or public\.is_admin\(\(select auth\.uid\(\)\)\) or public\.can_manage_users\(\(select auth\.uid\(\)\)\) \)/,
    );
    // The USING half must stay owner-or-super-admin.
    expect(p.match(/can_manage_users/g)).toHaveLength(1);
  });
});

describe("handle_new_user", () => {
  it("always creates a member and never reads a role from user metadata", () => {
    const def =
      /create or replace function public\.handle_new_user\(\)([\s\S]*?)\$\$;/
        .exec(sql)![0]
        .replace(/\s+/g, " ");
    expect(def).toMatch(/security definer/);
    expect(def).toMatch(/set search_path = ''/);
    expect(def).toMatch(/'member'\s*\);/);
    expect(def).not.toMatch(/raw_user_meta_data ->> 'role'/);
    // full_name is still fine to copy — it is not a privilege.
    expect(def).toMatch(/raw_user_meta_data ->> 'full_name'/);
  });
});

describe("the workspace owner is promoted, guarded", () => {
  it("promotes aicoach@referrizer.com and no-ops when the account is absent", () => {
    const stmt = /update public\.profiles p[\s\S]*?;/
      .exec(sql)![0]
      .replace(/\s+/g, " ");
    expect(stmt).toMatch(/set role = 'super_admin'/);
    expect(stmt).toMatch(/where p\.role <> 'super_admin'/);
    expect(stmt).toMatch(/and exists \( select 1 from auth\.users u/);
    expect(stmt).toMatch(/lower\(u\.email\) = 'aicoach@referrizer\.com'/);
  });

  it("leaves the other two live accounts where they are", () => {
    expect(sql).not.toMatch(/marie@referrizer\.com/);
    expect(sql).not.toMatch(/marketing@referrizer\.com/);
  });
});

describe("no other migration redefines the predicates afterwards", () => {
  const dir = fileURLToPath(new URL(`../${MIGRATIONS}`, import.meta.url));
  const later = readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && f > ROLES)
    .sort();

  it.each(later.length ? later : [""])("%s", (file) => {
    if (!file) return; // nothing after this migration yet
    const body = stripComments(read(`${MIGRATIONS}/${file}`));
    expect(
      body,
      `${file} redefines is_admin — it must keep delegating to is_super_admin`,
    ).not.toMatch(/create (or replace )?function public\.is_admin\(/i);
  });
});
