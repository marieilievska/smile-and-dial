import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

/** Settings landing route. Round 30 — now drops everyone on the
 *  overview hub instead of a deep sub-page. The hub is no longer a
 *  passive card index: it shows what's configured vs missing and the
 *  single most important next step, so the Settings link answers
 *  "is my workspace ready to make calls?" at a glance. The grouped
 *  left rail still handles direct navigation once you know where you
 *  want to go. */
export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  redirect("/settings/overview");
}
