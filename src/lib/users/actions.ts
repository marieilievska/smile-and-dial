"use server";

import { revalidatePath } from "next/cache";

import { appBaseUrl } from "@/lib/app-url";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type ActionResult = { error: string | null };

type Supabase = Awaited<ReturnType<typeof createClient>>;

/** Verify the caller is an admin. Returns their id, or an error message. */
async function requireAdmin(
  supabase: Supabase,
): Promise<{ userId: string } | { error: string }> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") return { error: "You are not authorized." };

  return { userId: user.id };
}

/** Change a user's role. Admins cannot change their own role. */
export async function updateUserRole(
  targetUserId: string,
  role: "admin" | "member",
): Promise<ActionResult> {
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if ("error" in auth) return { error: auth.error };
  if (targetUserId === auth.userId) {
    return { error: "You can't change your own role." };
  }

  const { error } = await supabase
    .from("profiles")
    .update({ role })
    .eq("id", targetUserId);
  if (error) return { error: "Could not update the role." };

  revalidatePath("/settings/users");
  return { error: null };
}

/** Activate or deactivate a user. Admins cannot deactivate themselves. */
export async function setUserActive(
  targetUserId: string,
  active: boolean,
): Promise<ActionResult> {
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if ("error" in auth) return { error: auth.error };
  if (targetUserId === auth.userId) {
    return { error: "You can't deactivate your own account." };
  }

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

  revalidatePath("/settings/users");
  return { error: null };
}

/**
 * Permanently delete a user. Admin-only; you can't delete yourself, and the
 * user must be deactivated first (a guardrail against fat-fingering an active
 * teammate). Removes the auth login and everything they own.
 *
 * Foreign keys force an order: calls→leads and leads→lists are ON DELETE
 * RESTRICT, and campaigns reference agents/goals, so we clear the
 * restriction-blocking rows ourselves before the auth-user delete cascades
 * the rest (profile, saved views, integrations, etc.).
 */
export async function deleteUser(targetUserId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if ("error" in auth) return { error: auth.error };
  if (targetUserId === auth.userId) {
    return { error: "You can't delete your own account." };
  }

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
  role: "admin" | "member",
): Promise<ActionResult> {
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if ("error" in auth) return { error: auth.error };

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
  const { error } = await admin.auth.admin.inviteUserByEmail(trimmed, {
    data: { role },
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

  revalidatePath("/settings/users");
  return { error: null };
}

/** Send a user a password-reset email. */
export async function sendPasswordReset(email: string): Promise<ActionResult> {
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if ("error" in auth) return { error: auth.error };

  const { error } = await supabase.auth.resetPasswordForEmail(email);
  if (error) return { error: "Could not send the reset email." };

  return { error: null };
}
