import { redirect } from "next/navigation";

import { SettingsNav } from "@/components/app-shell/settings-nav";
import { createClient } from "@/lib/supabase/server";

/** Settings layout. Round 28 — renders a vertical left rail on
 *  `lg+` screens (Referrizer "Detached Sidebar Workspace" pattern)
 *  so the section context (Workspace / Administration groups) stays
 *  visible while inner views swap. Below `lg`, the same nav falls
 *  back to a horizontal tab row above the page so a small canvas
 *  isn't eaten by the rail.
 *
 *  Both surfaces render the same SettingsNav component with
 *  different `orientation` props — single source of truth. */
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
  const isAdmin = profile?.role === "admin";

  return (
    <div className="flex flex-col lg:flex-row">
      {/* Below lg — horizontal tab row above the page. */}
      <div className="border-border border-b px-8 pt-6 lg:hidden">
        <SettingsNav isAdmin={isAdmin} orientation="horizontal" />
      </div>

      {/* lg+ — sticky left rail. Width is fixed so deep settings pages
       *  (long agents lists, integrations forms) don't reflow when the
       *  pathname changes. */}
      <aside
        aria-label="Settings sections"
        className="border-border hidden w-56 shrink-0 border-r p-6 lg:block"
      >
        <div className="sticky top-6">
          <SettingsNav isAdmin={isAdmin} orientation="vertical" />
        </div>
      </aside>

      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
