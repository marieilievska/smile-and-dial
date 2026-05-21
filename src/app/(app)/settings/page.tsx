import { redirect } from "next/navigation";

import { PagePlaceholder } from "@/components/page-placeholder";
import { createClient } from "@/lib/supabase/server";

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

  if (profile?.role === "admin") {
    redirect("/settings/users");
  }

  return (
    <PagePlaceholder
      title="Settings"
      description="Your profile settings will appear here in a later phase."
    />
  );
}
