import { redirect } from "next/navigation";

import { AppSidebar } from "@/components/app-shell/sidebar";
import { TopBar } from "@/components/app-shell/top-bar";
import { Toaster } from "@/components/ui/sonner";
import { createClient } from "@/lib/supabase/server";

/** Inline script that runs before React hydrates so the page renders
 *  with the user's chosen theme on first paint (no flash). Reads the
 *  same key the ThemeToggle client component writes to. */
const THEME_INIT_SCRIPT = `
  try {
    var t = localStorage.getItem('sd-theme') || 'system';
    var mql = window.matchMedia('(prefers-color-scheme: dark)');
    var dark = t === 'dark' || (t === 'system' && mql.matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch (_) {}
`;

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

  // Round 27 — also pull the active-campaign FK + every campaign the
  // operator can pick from (for the top-bar chip) + small status
  // counts for the sidebar dots. All in one Promise.all so the layout
  // server-renders in one round-trip.
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const [
    { data: profile },
    { data: rawNotifications },
    { count: unreadCount },
    { data: rawSavedViews },
    { data: campaignOptions },
    { count: overdueCallbacks },
    { count: pausedCampaigns },
    { count: recentErrors24h },
  ] = await Promise.all([
    supabase
      .from("profiles")
      .select("full_name, email, role, active_campaign_id")
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
    supabase
      .from("campaigns")
      .select("id, name, status")
      .neq("status", "ended")
      .order("name"),
    // Sidebar status dot: pending callbacks whose scheduled_at is past.
    supabase
      .from("callbacks")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .lt("scheduled_at", new Date().toISOString()),
    // Sidebar status dot: campaigns auto-paused (paused_reason set).
    supabase
      .from("campaigns")
      .select("id", { count: "exact", head: true })
      .eq("status", "paused")
      .not("paused_reason", "is", null),
    // Sidebar status dot: system_events with kind tied to error
    // severity in the last 24h (admin only — RLS filters for members).
    supabase
      .from("system_events")
      .select("id", { count: "exact", head: true })
      .in("kind", ["webhook_error", "dialer_failure", "orphan_call"])
      .gte("created_at", todayStart.toISOString()),
  ]);

  const name = profile?.full_name || profile?.email || user.email || "User";
  const email = profile?.email || user.email || "";
  const role = profile?.role ?? "member";
  const notifications = rawNotifications ?? [];
  const savedViews = rawSavedViews ?? [];
  const allCampaigns = campaignOptions ?? [];

  const activeCampaign = profile?.active_campaign_id
    ? (allCampaigns.find((c) => c.id === profile.active_campaign_id) ?? null)
    : null;

  const statusCounts = {
    callbacks: overdueCallbacks ?? 0,
    campaigns: pausedCampaigns ?? 0,
    systemHealth: recentErrors24h ?? 0,
  };

  return (
    <>
      {/* Run the no-flash theme script before paint. */}
      <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      <div className="flex h-screen w-full overflow-hidden">
        <AppSidebar
          isAdmin={role === "admin"}
          savedViews={savedViews}
          statusCounts={statusCounts}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            name={name}
            email={email}
            role={role}
            notifications={notifications}
            unreadCount={unreadCount ?? 0}
            activeCampaign={activeCampaign}
            campaigns={allCampaigns}
          />
          <main className="flex-1 overflow-y-auto">{children}</main>
        </div>
        <Toaster />
      </div>
    </>
  );
}
