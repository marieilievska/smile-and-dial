import { redirect } from "next/navigation";

import { AppSidebar } from "@/components/app-shell/sidebar";
import { TopBar } from "@/components/app-shell/top-bar";
import { createClient } from "@/lib/supabase/server";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, email, role")
    .eq("id", user.id)
    .single();

  const name = profile?.full_name || profile?.email || user.email || "User";
  const email = profile?.email || user.email || "";
  const role = profile?.role ?? "member";

  return (
    <div className="flex h-screen w-full overflow-hidden">
      <AppSidebar isAdmin={role === "admin"} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar name={name} email={email} role={role} />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
