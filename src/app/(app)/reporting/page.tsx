import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { buildDailyRows } from "@/lib/agent-analytics/daily";
import {
  detectCampaignFields,
  type DetectedFields,
} from "@/lib/agent-analytics/field-detect";
import { yesterdayEt } from "@/lib/agent-analytics/stats";
import {
  DASHBOARD_DAYS,
  fetchCauseOfDeath,
  fetchChangelogRows,
  fetchDashboardKpis,
  fetchPromptLogRows,
  type DashboardKpiScope,
} from "@/lib/agent-analytics/report-data";
import {
  parseScopeParam,
  serializeScope,
  type ReportScope,
} from "@/lib/agent-analytics/scope";
import { fetchCohortRows } from "@/lib/cohorts/data";

import { CauseOfDeathView } from "./cause-of-death-view";
import { ChangelogTable } from "./changelog-table";
import { CopyShareLinkButton } from "./copy-share-link-button";
import { DailyView } from "./daily-view";
import { PromptLogTable } from "./prompt-log-table";
import { NumbersPanel } from "./numbers-panel";
import {
  ReportingTabs,
  reportingTabsFor,
  resolveTabParam,
} from "./reporting-tabs";
import { ScopePicker } from "./scope-picker";
import { isSuperAdmin } from "@/lib/auth/roles";

function str(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}

/** A short, file-safe label for the current scope, used in CSV filenames. */
function scopeSlug(scope: ReportScope, label: string): string {
  if (scope.kind === "all") return "all-campaigns";
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || scope.kind
  );
}

export default async function AgentAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  // Reporting is open to members, not admins only. Every figure on the tabs a
  // member can see is scoped by row-level security to leads they own —
  // `calls_select` reads "admin sees all, else leads you own", as do `leads`,
  // `calendly_events` and `cost_rollup_daily`, and the Cohorts RPC is
  // SECURITY INVOKER so the same policies apply to it. There is deliberately no
  // second check here: a UI filter that disagreed with RLS is how data leaks.
  const isAdmin = isSuperAdmin(me?.role);

  const [{ data: campaignRows }, { data: agentRows }] = await Promise.all([
    supabase.from("campaigns").select("id, name").order("name"),
    supabase.from("agents").select("id, name").order("name"),
  ]);
  const campaigns = (campaignRows ?? []) as { id: string; name: string }[];
  const agents = (agentRows ?? []) as { id: string; name: string }[];

  // Parse + validate the scope. A stale id (deleted campaign) falls back to All.
  let scope = parseScopeParam(str(params.scope));
  let scopeLabel = "All campaigns (combined)";
  if (scope.kind === "campaign") {
    const campaignId = scope.campaignId;
    const found = campaigns.find((c) => c.id === campaignId);
    if (found) scopeLabel = found.name;
    else scope = { kind: "all" };
  }
  const scopeParam = serializeScope(scope);

  // Detect the campaign's own sentiment + notes fields (combined view has none).
  // Voice of Customer shows when a sentiment field is detected; Hot Leads keeps
  // its interest-driven gate.
  const detected: DetectedFields =
    scope.kind === "campaign"
      ? await detectCampaignFields(supabase, scope.campaignId)
      : { sentimentKey: null, sentimentValues: [], notesKey: null };
  const visibleTabs = reportingTabsFor({ isAdmin });
  const tab = resolveTabParam(str(params.tab), visibleTabs);

  const kpiScope: DashboardKpiScope =
    scope.kind === "all" ? { all: true } : { campaignIds: [scope.campaignId] };

  // Public read-only share token (revocable from settings). When set, admins
  // get a "Copy share link" button; when blank, the link is disabled.
  const { data: shareRow } = await supabase
    .from("app_settings")
    .select("agent_analytics_share_token")
    .eq("id", 1)
    .maybeSingle();
  const shareToken = shareRow?.agent_analytics_share_token ?? "";

  const slug = scopeSlug(scope, scopeLabel);

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            Reporting
          </h1>
          <p className="text-muted-foreground mt-0.5 text-sm">
            Agent performance, call results, and app changes. Pick a campaign to
            scope the view.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ScopePicker
            campaigns={campaigns}
            value={scopeParam}
            basePath="/reporting"
          />
          {shareToken ? <CopyShareLinkButton token={shareToken} /> : null}
        </div>
      </div>

      <ReportingTabs
        active={tab}
        tabs={visibleTabs}
        hrefFor={(k) => `/reporting?tab=${k}&scope=${scopeParam}`}
      />

      {tab === "daily" ? (
        <DailyTab
          kpiScope={kpiScope}
          selectedDay={str(params.day)}
          scopeParam={scopeParam}
          slug={slug}
          sentimentKey={detected.sentimentKey}
          showWarm={detected.sentimentValues.length > 0}
          isAdmin={isAdmin}
        />
      ) : tab === "cause-of-death" ? (
        <CauseOfDeathTab kpiScope={kpiScope} />
      ) : tab === "numbers" ? (
        <NumbersPanel />
      ) : tab === "changelog" ? (
        <ChangelogTab />
      ) : tab === "prompt-log" ? (
        <PromptLogTab scope={scope} agents={agents} />
      ) : null}
    </div>
  );
}

async function DailyTab({
  kpiScope,
  selectedDay,
  scopeParam,
  slug,
  sentimentKey,
  showWarm,
  isAdmin,
}: {
  kpiScope: DashboardKpiScope;
  selectedDay: string;
  scopeParam: string;
  slug: string;
  sentimentKey: string | null;
  showWarm: boolean;
  isAdmin: boolean;
}) {
  const supabase = await createClient();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(selectedDay)
    ? selectedDay
    : yesterdayEt();
  // Both halves of a row load together — the activity counts and the outcomes
  // that day produced are one table now, so fetching them in series would just
  // be one round trip's latency for nothing. Per-day operator notes ride along;
  // `dashboard_notes` is admin-only in RLS, so a member simply gets none.
  //
  // Both halves take their campaign ids from the SAME `kpiScope`, so a scoped
  // call count can never end up beside workspace-wide registrations and spend
  // — which is what made every $/reg on this page wrong before 20260908100000.
  const [activity, cohorts, { data: noteRows }] = await Promise.all([
    fetchDashboardKpis(supabase, kpiScope, sentimentKey),
    fetchCohortRows(supabase, kpiScope.campaignIds),
    supabase.from("dashboard_notes").select("day, note"),
  ]);
  const notes: Record<string, string> = {};
  for (const r of noteRows ?? []) notes[r.day] = r.note;
  return (
    <DailyView
      rows={buildDailyRows(activity, cohorts)}
      day={day}
      historyDays={DASHBOARD_DAYS}
      dayHrefFor={(d) => `/reporting?tab=daily&scope=${scopeParam}&day=${d}`}
      notes={notes}
      notesEditable={isAdmin}
      scopeSlug={slug}
      showMoney
      showActions
      showWarm={showWarm}
    />
  );
}

async function CauseOfDeathTab({ kpiScope }: { kpiScope: DashboardKpiScope }) {
  const supabase = await createClient();
  const summary = await fetchCauseOfDeath(supabase, kpiScope);
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Cause of Death</h2>
        <p className="text-muted-foreground text-sm">
          For every lead worked in the last {DASHBOARD_DAYS} days, the primary
          reason it hasn&apos;t been won. Final losses vs still in play.
        </p>
      </div>
      <CauseOfDeathView summary={summary} />
    </section>
  );
}

async function ChangelogTab() {
  const supabase = await createClient();
  const rows = await fetchChangelogRows(supabase);
  return <ChangelogTable key={rows.map((r) => r.id).join(",")} rows={rows} />;
}

async function PromptLogTab({
  scope,
  agents,
}: {
  scope: ReportScope;
  agents: { id: string; name: string }[];
}) {
  const supabase = await createClient();
  const rows = await fetchPromptLogRows(supabase, scope);
  return (
    <PromptLogTable
      key={rows.map((r) => r.id).join(",")}
      rows={rows}
      agents={agents}
    />
  );
}
