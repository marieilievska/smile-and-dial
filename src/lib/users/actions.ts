"use server";

import { revalidatePath } from "next/cache";

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
