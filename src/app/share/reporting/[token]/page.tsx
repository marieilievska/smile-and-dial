import { notFound } from "next/navigation";

import { createClient as createServiceClient } from "@supabase/supabase-js";

import { ChangelogTable } from "@/app/(app)/reporting/changelog-table";
import { DashboardView } from "@/app/(app)/reporting/dashboard-view";
import { HotLeadsTable } from "@/app/(app)/reporting/hot-leads-table";
import { PromptLogTable } from "@/app/(app)/reporting/prompt-log-table";
import {
  ReportingTabs,
  reportingTabsFor,
} from "@/app/(app)/reporting/reporting-tabs";
import { ScopePicker } from "@/app/(app)/reporting/scope-picker";
import { VoiceTable } from "@/app/(app)/reporting/voice-table";
import {
  detectCampaignFields,
  type DetectedFields,
} from "@/lib/agent-analytics/field-detect";
import {
  DASHBOARD_DAYS,
  fetchChangelogRows,
  fetchDashboardKpis,
  fetchHotLeadRows,
  fetchPromptLogRows,
  fetchVoiceRows,
  hasInterestData,
} from "@/lib/agent-analytics/report-data";
import { parseScopeParam, serializeScope } from "@/lib/agent-analytics/scope";
import { yesterdayEt } from "@/lib/agent-analytics/stats";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

// Public, read-only, all-agents combined reporting view, gated by an
// unguessable token in the URL (validated against app_settings, so it's
// revocable). No login. Same tabs as the in-app page, all rendered read-only.
// Never indexed.
export const metadata = {
  title: "Reporting",
  robots: { index: false, follow: false },
};

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

  // Scope-aware: a read-only campaign picker drives the same per-campaign
  // detection as the admin page. A stale id falls back to the combined view.
  const { data: campaignRows } = await supabase
    .from("campaigns")
    .select("id, name")
    .order("name");
  const campaigns = (campaignRows ?? []) as { id: string; name: string }[];

  let scope = parseScopeParam(str(sp.scope));
  if (scope.kind === "campaign") {
    const campaignId = scope.campaignId;
    if (!campaigns.some((c) => c.id === campaignId)) scope = { kind: "all" };
  }
  const scopeParam = serializeScope(scope);

  const detected: DetectedFields =
    scope.kind === "campaign"
      ? await detectCampaignFields(supabase, scope.campaignId)
      : { sentimentKey: null, sentimentValues: [], notesKey: null };
  const showVoice = scope.kind === "campaign" && detected.sentimentKey !== null;
  const showHotLeads =
    scope.kind === "campaign" && (await hasInterestData(supabase, scope));
  const visibleTabs = reportingTabsFor({ showVoice, showHotLeads });
  const tab = visibleTabs.some((t) => t.key === str(sp.tab))
    ? str(sp.tab)
    : "dashboard";

  const kpiScope =
    scope.kind === "all" ? { all: true } : { campaignIds: [scope.campaignId] };

  // Per-day comments on the dashboard: read-only to anyone with the link, and
  // editable when a logged-in admin is viewing the preview (the
  // upsertDashboardNote action re-checks admin, so this is safe).
  let dashNotes: Record<string, string> | undefined;
  let viewerIsAdmin = false;
  if (tab === "dashboard") {
    const { data: noteRows } = await supabase
      .from("dashboard_notes")
      .select("day, note");
    dashNotes = {};
    for (const r of noteRows ?? []) dashNotes[r.day] = r.note;
    try {
      const userClient = await createClient();
      const {
        data: { user },
      } = await userClient.auth.getUser();
      if (user) {
        const { data: me } = await userClient
          .from("profiles")
          .select("role")
          .eq("id", user.id)
          .single();
        viewerIsAdmin = me?.role === "admin";
      }
    } catch {
      // Anonymous viewer — notes stay read-only.
    }
  }

  return (
    <main className="bg-background text-foreground min-h-screen">
      <div className="mx-auto flex max-w-6xl flex-col gap-5 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-foreground text-2xl font-bold tracking-tight">
              Reporting
            </h1>
            <p className="text-muted-foreground mt-0.5 text-sm">
              Read-only shared view · updates live.
            </p>
          </div>
          <ScopePicker
            campaigns={campaigns}
            value={scopeParam}
            basePath={`/share/reporting/${token}`}
          />
        </div>

        <ReportingTabs
          active={tab}
          tabs={visibleTabs}
          hrefFor={(k) =>
            `/share/reporting/${token}?tab=${k}&scope=${scopeParam}`
          }
        />

        {tab === "dashboard" ? (
          <DashboardView
            kpis={await fetchDashboardKpis(
              supabase,
              kpiScope,
              detected.sentimentKey,
            )}
            day={yesterdayEt()}
            historyDays={DASHBOARD_DAYS}
            notes={dashNotes}
            notesEditable={viewerIsAdmin}
            scopeSlug={scope.kind === "campaign" ? "campaign" : "all-campaigns"}
            sentimentValues={detected.sentimentValues}
          />
        ) : tab === "voice" ? (
          <VoiceTable
            rows={await fetchVoiceRows(supabase, scope, detected)}
            sentimentValues={detected.sentimentValues}
            recordingSrcFor={(id) =>
              `/share/reporting/${token}/recording/${id}`
            }
            readOnly
            scopeSlug="campaign"
          />
        ) : tab === "hot-leads" ? (
          <HotLeadsTable
            rows={await fetchHotLeadRows(supabase)}
            readOnly
            scopeSlug="all-campaigns"
          />
        ) : tab === "changelog" ? (
          <ChangelogTable rows={await fetchChangelogRows(supabase)} readOnly />
        ) : tab === "prompt-log" ? (
          <PromptLogTable rows={await fetchPromptLogRows(supabase)} readOnly />
        ) : null}
      </div>
    </main>
  );
}
