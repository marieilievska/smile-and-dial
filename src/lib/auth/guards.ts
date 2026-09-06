import { createClient } from "@/lib/supabase/server";

import { asAppRole, canManageUsers, isSuperAdmin, type AppRole } from "./roles";

/**
 * Server-side role gates for the three tiers (20260906010000).
 *
 * Pick by MEANING, not by who happens to hold the role today:
 *
 *   requireSuperAdmin   the caller is about to see or touch rows that may
 *                       belong to somebody else, or to run something
 *                       workspace-wide (settings, maintenance jobs, the
 *                       cross-owner bulk deletes, share-token surfaces).
 *                       This is the app-side twin of the RLS `is_admin()`.
 *
 *   requireUserManager  the caller is about to use an elevated power that
 *                       stays inside what they can already see: managing
 *                       teammates, handing over rows they own, curating the
 *                       shared agent templates. Twin of `can_manage_users()`.
 *
 * Not a "use server" module on purpose — these are plain helpers, so a server
 * action file can import them without every export having to be an action.
 */

type Supabase = Awaited<ReturnType<typeof createClient>>;

export type Caller = { userId: string; role: AppRole };
export type Denied = { error: string };

/** Resolve the signed-in user and their tier, or null when signed out. */
export async function currentCaller(client?: Supabase): Promise<Caller | null> {
  const supabase = client ?? (await createClient());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  return { userId: user.id, role: asAppRole(me?.role) };
}

/** Gate on "sees everything". */
export async function requireSuperAdmin(
  client?: Supabase,
): Promise<Caller | Denied> {
  const caller = await currentCaller(client);
  if (!caller) return { error: "You are not signed in." };
  if (!isSuperAdmin(caller.role)) {
    return { error: "Only a super admin can do that." };
  }
  return caller;
}

/** Gate on the admin tier (admin or super admin). */
export async function requireUserManager(
  client?: Supabase,
): Promise<Caller | Denied> {
  const caller = await currentCaller(client);
  if (!caller) return { error: "You are not signed in." };
  if (!canManageUsers(caller.role)) {
    return { error: "You are not authorized." };
  }
  return caller;
}

/** Narrowing helper so call sites read as `if (isDenied(auth)) ...`. */
export function isDenied(result: Caller | Denied): result is Denied {
  return "error" in result;
}
