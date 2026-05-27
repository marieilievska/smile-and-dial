import { redirect } from "next/navigation";

import { AppSidebar } from "@/components/app-shell/sidebar";
import { TopBar } from "@/components/app-shell/top-bar";
import { Toaster } from "@/components/ui/sonner";
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

  const [
    { data: profile },
    { data: rawNotifications },
    { count: unreadCount },
    { data: rawSavedViews },
  ] = await Promise.all([
    supabase
      .from("profiles")
      .select("full_name, email, role")
      .eq("id", user.id)
      .single(),
    supabase
      .from("notifications")
      .select("id, kind, message, ref_table, ref_id, read_at, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .is("read_at", null),
    supabase
      .from("saved_views")
      .select("id, page, name, params")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true }),
  ]);

  const name = profile?.full_name || profile?.email || user.email || "User";
  const email = profile?.email || user.email || "";
  const role = profile?.role ?? "member";
  const notifications = rawNotifications ?? [];
  const savedViews = rawSavedViews ?? [];

  return (
    <div className="flex h-screen w-full overflow-hidden">
      <AppSidebar isAdmin={role === "admin"} savedViews={savedViews} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          name={name}
          email={email}
          role={role}
          notifications={notifications}
          unreadCount={unreadCount ?? 0}
        />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
      <Toaster />
    </div>
  );
}
