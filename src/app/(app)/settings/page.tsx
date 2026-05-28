import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

/** Settings landing route. Round 23 — kept as a role-aware redirect
 *  rather than a fresh overview surface. The Settings sidebar link
 *  should drop the user on the first sub-page they actually need,
 *  not an in-between hub. The grouped sub-nav (Workspace /
 *  Administration) handles the "where am I?" question. */
export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  redirect(profile?.role === "admin" ? "/settings/users" : "/settings/lists");
}
