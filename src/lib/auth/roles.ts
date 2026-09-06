/**
 * The three role tiers, and the two INDEPENDENT questions they answer.
 *
 *   What you can SEE        isSuperAdmin()   — every row, belonging to anyone.
 *   What you may DO         canManageUsers() — invite / deactivate / remove
 *                                              teammates, hand over what you
 *                                              own, curate agent templates.
 *
 *   super_admin  sees everything, can do everything (workspace settings, the
 *                maintenance jobs, moving things between two other people).
 *   admin        sees only what they own, plus the powers above.
 *   member       sees only what they own, own work only.
 *
 * These mirror the SQL predicates added in 20260906010000:
 *   isSuperAdmin   <->  public.is_super_admin(uid)   (and the legacy
 *                       public.is_admin(uid), which now delegates to it)
 *   canManageUsers <->  public.can_manage_users(uid)
 *
 * Keep them in lock-step. A UI that promises more than RLS delivers is how a
 * page ends up permanently empty with no explanation; a UI that promises less
 * is how a capability quietly disappears.
 *
 * Deliberately dependency-free so both Server Components and "use client"
 * components can import it (see reference: never import a value from a
 * "use client" module into a Server Component — this module is neither).
 */

export const APP_ROLES = ["super_admin", "admin", "member"] as const;

export type AppRole = (typeof APP_ROLES)[number];

/** Human labels. `profiles.role` is stored snake_case; never render it raw. */
export const ROLE_LABELS: Record<AppRole, string> = {
  super_admin: "Super admin",
  admin: "Admin",
  member: "Member",
};

/** One line per tier, for role pickers and help text. */
export const ROLE_DESCRIPTIONS: Record<AppRole, string> = {
  super_admin:
    "Sees everyone's data and can do everything: workspace settings, maintenance jobs, and moving work between teammates.",
  admin:
    "Sees only their own work, plus manages teammates, hands over what they own, and curates agent templates.",
  member:
    "Builds and runs calls on their own leads, agents, numbers, custom fields and campaigns.",
};

/** Narrow an unknown `profiles.role` string. Anything unrecognised (or a row
 *  we could not read) is treated as the least-privileged tier. */
export function asAppRole(role: string | null | undefined): AppRole {
  return (APP_ROLES as readonly string[]).includes(role ?? "")
    ? (role as AppRole)
    : "member";
}

/** SEES EVERYTHING. The app-side twin of `public.is_admin()` after
 *  20260906010000 — use this wherever the UI shows or acts on rows that may
 *  belong to somebody else (owner columns and filters, cross-owner deletes,
 *  workspace-wide jobs and settings). */
export function isSuperAdmin(role: string | null | undefined): boolean {
  return asAppRole(role) === "super_admin";
}

/** ELEVATED POWER over teammates and shared shelves, without any extra
 *  visibility. The app-side twin of `public.can_manage_users()`. */
export function canManageUsers(role: string | null | undefined): boolean {
  const r = asAppRole(role);
  return r === "admin" || r === "super_admin";
}

/** Which roles this actor may hand out. A super admin may create or demote
 *  another super admin; a plain admin may not mint one, matching the
 *  profiles_insert / profiles_update guards in the migration. */
export function assignableRoles(actor: string | null | undefined): AppRole[] {
  if (isSuperAdmin(actor)) return ["super_admin", "admin", "member"];
  if (canManageUsers(actor)) return ["admin", "member"];
  return [];
}

/** True when `actor` may change, deactivate or delete `target`'s account.
 *  Mirrors the profiles write policies: never yourself, and only a super
 *  admin may touch another super admin. */
export function canActOnUser(
  actor: string | null | undefined,
  target: string | null | undefined,
  isSelf: boolean,
): boolean {
  if (isSelf) return false;
  if (!canManageUsers(actor)) return false;
  if (asAppRole(target) === "super_admin") return isSuperAdmin(actor);
  return true;
}
