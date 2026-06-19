"use server";

import { createClient as createAdminClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

type SupabaseAdmin = ReturnType<typeof createAdminClient<Database>>;

function adminClient(): SupabaseAdmin {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return createAdminClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** True when the caller is a signed-in admin. All Agent Analytics writes are
 *  admin-only (the page is admin-gated too — this is the server-side backstop). */
async function isCallerAdmin(): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return false;
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  return me?.role === "admin";
}

/** Save an operator's theme / suggested-action annotation on a call (Voice of
 *  Customer tab). Empty string clears the field. */
export async function saveCallAnnotation(input: {
  callId: string;
  field: "theme" | "suggested_action";
  value: string;
}): Promise<{ error: string | null }> {
  if (!(await isCallerAdmin())) return { error: "Admins only." };
  const value = input.value.trim() || null;
  const patch =
    input.field === "theme" ? { theme: value } : { suggested_action: value };
  const { error } = await adminClient()
    .from("calls")
    .update(patch)
    .eq("id", input.callId);
  return { error: error ? "Could not save." : null };
}
