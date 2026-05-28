import { redirect } from "next/navigation";

import { MobileNavTrigger } from "@/components/app-shell/mobile-nav-trigger";
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
      {/* Round 35 (X4) — skip-to-content link for keyboard / screen
       *  reader users. Hidden until focused, then jumps focus past
       *  the top-bar and nav into #main-content. Honours the
       *  Referrizer palette so when it does appear it matches the
       *  shell. */}
      <a
        href="#main-content"
        className="bg-primary text-primary-foreground focus-visible:ring-ring/60 sr-only z-50 rounded-md px-3 py-2 text-sm font-medium shadow-md focus-visible:not-sr-only focus-visible:fixed focus-visible:top-3 focus-visible:left-3 focus-visible:ring-2 focus-visible:outline-none"
      >
        Skip to main content
      </a>
      <div className="flex h-screen w-full overflow-hidden">
        {/* Sidebar — persistent on md+, hidden on small screens
         *  where MobileNavTrigger surfaces it as a Sheet drawer. */}
        <div className="hidden md:flex">
          <AppSidebar
            isAdmin={role === "admin"}
            savedViews={savedViews}
            statusCounts={statusCounts}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            name={name}
            email={email}
            role={role}
            notifications={notifications}
            unreadCount={unreadCount ?? 0}
            activeCampaign={activeCampaign}
            campaigns={allCampaigns}
            mobileNav={
              <MobileNavTrigger
                isAdmin={role === "admin"}
                savedViews={savedViews}
                statusCounts={statusCounts}
              />
            }
          />
          <main
            id="main-content"
            tabIndex={-1}
            className="flex-1 overflow-y-auto"
          >
            {children}
          </main>
        </div>
        <Toaster />
      </div>
    </>
  );
}
