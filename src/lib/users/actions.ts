"use server";

import { revalidatePath } from "next/cache";

import { appBaseUrl } from "@/lib/app-url";
import { isDenied, requireUserManager } from "@/lib/auth/guards";
import { asAppRole, isSuperAdmin, type AppRole } from "@/lib/auth/roles";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type ActionResult = { error: string | null };

type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * Managing teammates is an ADMIN-TIER power (admin or super admin), not a
 * "sees everything" one — see src/lib/auth/roles.ts. Two guards go with it,
 * mirroring the profiles RLS policies in 20260906010000:
 *
 *   - nobody may act on their own account here (each action checks), and
 *   - only a super admin may create, change, deactivate or delete a super
 *     admin. A plain admin must not be able to mint one or demote one.
 */
async function requireTargetAllowed(
  supabase: Supabase,
  targetUserId: string,
): Promise<{ userId: string; role: AppRole } | { error: string }> {
  const auth = await requireUserManager(supabase);
  if (isDenied(auth)) return { error: auth.error };
  if (targetUserId === auth.userId) {
    return { error: "You can't change your own account." };
  }

  const { data: target } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", targetUserId)
    .maybeSingle();
  if (!target) return { error: "That user no longer exists." };
  if (asAppRole(target.role) === "super_admin" && !isSuperAdmin(auth.role)) {
    return { error: "Only a super admin can change a super admin." };
  }

  return auth;
}

/** Change a user's role. Nobody may change their own; only a super admin may
 *  hand out (or take away) the super-admin role. */
export async function updateUserRole(
  targetUserId: string,
  role: AppRole,
): Promise<ActionResult> {
  const supabase = await createClient();
  const auth = await requireTargetAllowed(supabase, targetUserId);
  if ("error" in auth) return { error: auth.error };
  if (role === "super_admin" && !isSuperAdmin(auth.role)) {
    return { error: "Only a super admin can make someone a super admin." };
  }

  const { error } = await supabase
    .from("profiles")
    .update({ role })
    .eq("id", targetUserId);
  if (error) return { error: "Could not update the role." };

  revalidatePath("/settings/users");
  return { error: null };
}

/** Activate or deactivate a user. Nobody may deactivate themselves. */
export async function setUserActive(
  targetUserId: string,
  active: boolean,
): Promise<ActionResult> {
  const supabase = await createClient();
  const auth = await requireTargetAllowed(supabase, targetUserId);
  if ("error" in auth) return { error: auth.error };

  const { error } = await supabase
    .from("profiles")
    .update({ active })
    .eq("id", targetUserId);
  if (error) return { error: "Could not update the account status." };

  // Block (or restore) the user's ability to sign in.
  const admin = createAdminClient();
  await admin.auth.admin.updateUserById(targetUserId, {
    ban_duration: active ? "none" : "876000h",
  });

  if (!active) {
    // Cut off every other way in, not just the next password login.
    //
    // API keys are bearer credentials that never expire on their own, so
    // revoke them (soft, like the Settings → API "Revoke" button: revoked_at
    // is set and the row stays for audit). Re-activating does NOT restore
    // them — the user creates a fresh key.
    await admin
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("owner_id", targetUserId)
      .is("revoked_at", null);

    // Sessions: the ban above stops the user's session from REFRESHING, but an
    // already-issued access token stays valid until it expires (~1h). This
    // supabase-js (2.106) admin API can only sign out a session whose JWT it
    // holds (`auth.admin.signOut(jwt)`) — there is no "sign out user by id" —
    // so the (app) layout reads profiles.active on every page render and
    // bounces a deactivated user to /auth/signout, which revokes their
    // sessions globally from their own browser. The browser-dial TwiML route
    // checks profiles.active too, so a lingering token cannot place calls.
  }

  revalidatePath("/settings/users");
  return { error: null };
}

/**
 * Permanently delete a user. Admin tier only; you can't delete yourself, only
 * a super admin can delete a super admin, and the user must be deactivated
 * first (a guardrail against fat-fingering an active teammate). Removes the
 * auth login and everything they own.
 *
 * Foreign keys force an order: calls→leads and leads→lists are ON DELETE
 * RESTRICT, and campaigns reference agents/goals, so we clear the
 * restriction-blocking rows ourselves before the auth-user delete cascades
 * the rest (profile, saved views, integrations, etc.).
 */
export async function deleteUser(targetUserId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const auth = await requireTargetAllowed(supabase, targetUserId);
  if ("error" in auth) return { error: auth.error };

  const { data: target } = await supabase
    .from("profiles")
    .select("active")
    .eq("id", targetUserId)
    .maybeSingle();
  if (!target) return { error: "That user no longer exists." };
  if (target.active) return { error: "Deactivate the user before deleting." };

  const admin = createAdminClient();

  const { data: leads } = await admin
    .from("leads")
    .select("id")
    .eq("owner_id", targetUserId);
  const leadIds = (leads ?? []).map((l) => l.id);
  if (leadIds.length > 0) {
    await admin.from("calls").delete().in("lead_id", leadIds);
  }
  await admin.from("campaigns").delete().eq("owner_id", targetUserId);
  await admin.from("agents").delete().eq("owner_id", targetUserId);
  await admin.from("leads").delete().eq("owner_id", targetUserId);
  await admin.from("lists").delete().eq("owner_id", targetUserId);

  const { error } = await admin.auth.admin.deleteUser(targetUserId);
  if (error) return { error: "Could not delete the user." };

  revalidatePath("/settings/users");
  return { error: null };
}

/** Invite a new user by email. They receive a link to set a password. */
export async function inviteUser(
  email: string,
  role: AppRole,
): Promise<ActionResult> {
  const supabase = await createClient();
  const auth = await requireUserManager(supabase);
  if (isDenied(auth)) return { error: auth.error };
  if (role === "super_admin" && !isSuperAdmin(auth.role)) {
    return { error: "Only a super admin can invite a super admin." };
  }

  const trimmed = email.trim().toLowerCase();
  if (!trimmed) return { error: "Enter an email address." };

  const admin = createAdminClient();
  // Point the invite link at the production confirm route explicitly, so it
  // never falls back to a stale Supabase "Site URL" (e.g. localhost). The
  // target must also be in the project's Redirect URLs allow-list. Omitted
  // locally (appBaseUrl() is null) so dev uses the Site URL.
  const base = appBaseUrl();
  const redirectTo = base
    ? `${base}/auth/confirm?next=/auth/set-password`
    : undefined;
  // No `role` in the metadata on purpose. handle_new_user() used to copy
  // raw_user_meta_data->>'role' straight into profiles.role, which let a
  // signup pick its own role; since 20260906010000 the trigger always writes
  // 'member' and the invited role is applied below with the service-role
  // client instead — authorised code rather than user input.
  const { data, error } = await admin.auth.admin.inviteUserByEmail(trimmed, {
    redirectTo,
  });
  if (error) {
    if (
      error.status === 429 ||
      /rate.?limit/i.test(error.code ?? "") ||
      /rate limit/i.test(error.message)
    ) {
      return {
        error:
          "Email rate limit hit — too many invites in a short window. Wait a few minutes and try again, or set up a custom SMTP provider in Supabase for production volume.",
      };
    }
    if (/already|registered|exists/i.test(error.message)) {
      return { error: "A user with that email already exists." };
    }
    return { error: "Could not send the invitation." };
  }

  // Apply the invited role. The trigger has already created the row as
  // 'member', so a failure here leaves a usable (least-privileged) account
  // rather than a broken one — say so instead of pretending it worked.
  const invitedId = data?.user?.id;
  if (invitedId && role !== "member") {
    const { error: roleError } = await admin
      .from("profiles")
      .update({ role })
      .eq("id", invitedId);
    if (roleError) {
      revalidatePath("/settings/users");
      return {
        error:
          "The invitation was sent, but the role could not be set — they were added as a member. Change it from the user list.",
      };
    }
  }

  revalidatePath("/settings/users");
  return { error: null };
}

/** Send a user a password-reset email. */
export async function sendPasswordReset(email: string): Promise<ActionResult> {
  const supabase = await createClient();
  const auth = await requireUserManager(supabase);
  if (isDenied(auth)) return { error: auth.error };

  const { error } = await supabase.auth.resetPasswordForEmail(email);
  if (error) return { error: "Could not send the reset email." };

  return { error: null };
}
