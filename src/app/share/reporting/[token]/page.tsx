import Link from "next/link";
import { notFound } from "next/navigation";

import { createClient as createServiceClient } from "@supabase/supabase-js";

import { ChangelogTable } from "@/app/(app)/reporting/changelog-table";
import { DashboardView } from "@/app/(app)/reporting/dashboard-view";
import { HotLeadsTable } from "@/app/(app)/reporting/hot-leads-table";
import { PromptLogTable } from "@/app/(app)/reporting/prompt-log-table";
import { VoiceTable } from "@/app/(app)/reporting/voice-table";
import {
  DASHBOARD_DAYS,
  fetchChangelogRows,
  fetchDashboardKpis,
  fetchHotLeadRows,
  fetchPromptLogRows,
  fetchVoiceRows,
} from "@/lib/agent-analytics/report-data";
import { yesterdayEt } from "@/lib/agent-analytics/stats";
import type { Database } from "@/lib/supabase/database.types";

// Public, read-only share of the Market Research reporting page, gated by an
// unguessable token in the URL (validated against app_settings, so it's
// revocable). No login. Same tabs as the in-app page, all rendered read-only.
// Never indexed.
export const metadata = {
  title: "Market Research — Reporting",
  robots: { index: false, follow: false },
};

const TABS = [
  { key: "dashboard", label: "Dashboard" },
  { key: "voice", label: "Voice of Customer" },
  { key: "hot-leads", label: "Hot Leads" },
  { key: "changelog", label: "App Changelog" },
  { key: "prompt-log", label: "Agent Prompt Log" },
] as const;

function str(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}

export default async function PublicReporting({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) notFound();

  // Service-role client: no logged-in user here. The key stays server-side.
  const supabase = createServiceClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Validate the share token. A wrong/blank token 404s (revoke by clearing the
  // column). Empty stored token = link disabled.
  const { data: settings } = await supabase
    .from("app_settings")
    .select("agent_analytics_share_token")
    .eq("id", 1)
    .maybeSingle();
  const expected = settings?.agent_analytics_share_token ?? "";
  if (!expected || token !== expected) notFound();

  const tab = TABS.some((t) => t.key === str(sp.tab))
    ? str(sp.tab)
    : "dashboard";

  const { data: agent } = await supabase
    .from("agents")
    .select("id")
    .ilike("name", "%market research%")
    .maybeSingle();

  return (
    <main className="bg-background text-foreground min-h-screen">
      <div className="mx-auto flex max-w-6xl flex-col gap-5 p-6">
        <div>
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            Market Research — Reporting
          </h1>
          <p className="text-muted-foreground mt-0.5 text-sm">
            Read-only shared view · updates live.
          </p>
        </div>

        {/* Tab bar */}
        <div className="border-border flex flex-wrap gap-1 border-b">
          {TABS.map((t) => {
            const active = t.key === tab;
            return (
              <Link
                key={t.key}
                href={`/share/reporting/${token}?tab=${t.key}`}
                aria-current={active ? "page" : undefined}
                className={
                  "border-b-2 px-3 py-2 text-sm font-medium transition-colors " +
                  (active
                    ? "text-foreground border-[color:var(--primary)]"
                    : "text-muted-foreground hover:text-foreground border-transparent")
                }
              >
                {t.label}
              </Link>
            );
          })}
        </div>

        {!agent ? (
          <p className="text-muted-foreground text-sm">No data yet.</p>
        ) : tab === "dashboard" ? (
          <DashboardView
            kpis={await fetchDashboardKpis(supabase, agent.id)}
            day={yesterdayEt()}
            historyDays={DASHBOARD_DAYS}
          />
        ) : tab === "voice" ? (
          <VoiceTable
            rows={await fetchVoiceRows(supabase, agent.id)}
            readOnly
          />
        ) : tab === "hot-leads" ? (
          <HotLeadsTable rows={await fetchHotLeadRows(supabase)} readOnly />
        ) : tab === "changelog" ? (
          <ChangelogTable rows={await fetchChangelogRows(supabase)} readOnly />
        ) : tab === "prompt-log" ? (
          <PromptLogTable rows={await fetchPromptLogRows(supabase)} readOnly />
        ) : null}
      </div>
    </main>
  );
}
