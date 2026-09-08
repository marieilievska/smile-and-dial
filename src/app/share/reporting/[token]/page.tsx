import { notFound } from "next/navigation";

import { createClient as createServiceClient } from "@supabase/supabase-js";

import { CauseOfDeathView } from "@/app/(app)/reporting/cause-of-death-view";
import { ChangelogTable } from "@/app/(app)/reporting/changelog-table";
import { DailyView } from "@/app/(app)/reporting/daily-view";
import { PromptLogTable } from "@/app/(app)/reporting/prompt-log-table";
import {
  ReportingTabs,
  reportingTabsFor,
  resolveTabParam,
} from "@/app/(app)/reporting/reporting-tabs";
import { ScopePicker } from "@/app/(app)/reporting/scope-picker";
import { buildDailyRows, type DailyRow } from "@/lib/agent-analytics/daily";
import {
  detectCampaignFields,
  type DetectedFields,
} from "@/lib/agent-analytics/field-detect";
import {
  DASHBOARD_DAYS,
  fetchCauseOfDeath,
  fetchChangelogRows,
  fetchDashboardKpis,
  fetchPromptLogRows,
} from "@/lib/agent-analytics/report-data";
import { parseScopeParam, serializeScope } from "@/lib/agent-analytics/scope";
import { yesterdayEt } from "@/lib/agent-analytics/stats";
import { fetchCohortRows } from "@/lib/cohorts/data";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";
import { isSuperAdmin } from "@/lib/auth/roles";

// Public, read-only, all-agents combined reporting view, gated by an
// unguessable token in the URL (validated against app_settings, so it's
// revocable). No login. Same tabs as the in-app page minus Numbers, all
// rendered read-only. Never indexed.
//
// The Daily tab renders with `showMoney={false}`: registrations, attendance and
// sales are what the recipient is here to see, spend and the two cost-per
// figures are ours. This used to be done by dropping a whole tab, which took
// the outcomes with it.
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
  const visibleTabs = reportingTabsFor({ showNumbers: false });
  const tab = resolveTabParam(str(sp.tab), visibleTabs);

  const kpiScope =
    scope.kind === "all" ? { all: true } : { campaignIds: [scope.campaignId] };

  // Per-day comments on the Daily tab: read-only to anyone with the link, and
  // editable when a logged-in admin is viewing the preview (the
  // upsertDashboardNote action re-checks admin, so this is safe).
  let dailyRows: readonly DailyRow[] = [];
  let dashNotes: Record<string, string> | undefined;
  let viewerIsAdmin = false;
  if (tab === "daily") {
    const [activity, cohorts, { data: noteRows }] = await Promise.all([
      fetchDashboardKpis(supabase, kpiScope, detected.sentimentKey),
      fetchCohortRows(supabase),
      supabase.from("dashboard_notes").select("day, note"),
    ]);
    dailyRows = buildDailyRows(activity, cohorts);
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
        // dashboard_notes is is_admin()-only in RLS, i.e. super admin.
        viewerIsAdmin = isSuperAdmin(me?.role);
      }
    } catch {
      // Anonymous viewer — notes stay read-only.
    }
  }

  // Cause of Death: fetch only when that tab is active (mirrors the admin page).
  const causeOfDeath =
    tab === "cause-of-death"
      ? await fetchCauseOfDeath(supabase, kpiScope)
      : null;

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

        {tab === "daily" ? (
          <DailyView
            rows={dailyRows}
            day={yesterdayEt()}
            historyDays={DASHBOARD_DAYS}
            notes={dashNotes}
            notesEditable={viewerIsAdmin}
            scopeSlug={scope.kind === "campaign" ? "campaign" : "all-campaigns"}
            showMoney={false}
            showActions={false}
            showWarm={detected.sentimentValues.length > 0}
            cohortsUnscoped={scope.kind === "campaign"}
          />
        ) : tab === "cause-of-death" ? (
          causeOfDeath ? (
            <CauseOfDeathView summary={causeOfDeath} />
          ) : null
        ) : tab === "changelog" ? (
          <ChangelogTable rows={await fetchChangelogRows(supabase)} readOnly />
        ) : tab === "prompt-log" ? (
          <PromptLogTable
            rows={await fetchPromptLogRows(supabase, scope)}
            readOnly
          />
        ) : null}
      </div>
    </main>
  );
}
