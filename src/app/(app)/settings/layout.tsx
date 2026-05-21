import { redirect } from "next/navigation";

import { SettingsNav } from "@/components/app-shell/settings-nav";
import { createClient } from "@/lib/supabase/server";

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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

  return (
    <div>
      <div className="border-border border-b px-8 pt-6">
        <SettingsNav isAdmin={profile?.role === "admin"} />
      </div>
      {children}
    </div>
  );
}
