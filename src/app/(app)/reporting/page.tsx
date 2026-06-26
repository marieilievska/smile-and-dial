import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { yesterdayEt } from "@/lib/agent-analytics/stats";
import {
  DASHBOARD_DAYS,
  fetchAgentCampaignIds,
  fetchChangelogRows,
  fetchDashboardKpis,
  fetchHotLeadRows,
  fetchPromptLogRows,
  fetchVoiceRows,
  hasInterestData,
} from "@/lib/agent-analytics/report-data";
import {
  parseScopeParam,
  serializeScope,
  type ReportScope,
} from "@/lib/agent-analytics/scope";

import { ChangelogTable } from "./changelog-table";
import { CopyShareLinkButton } from "./copy-share-link-button";
import { DashboardView } from "./dashboard-view";
import { HotLeadsTable } from "./hot-leads-table";
import { PromptLogTable } from "./prompt-log-table";
import { ReportingTabs, reportingTabsFor } from "./reporting-tabs";
import { ScopePicker } from "./scope-picker";
import { VoiceTable } from "./voice-table";

function str(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}

/** A short, file-safe label for the current scope, used in CSV filenames. */
function scopeSlug(scope: ReportScope, label: string): string {
  if (scope.kind === "all") return "all-agents";
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
  if (me?.role !== "admin") redirect("/");

  // Load every agent + campaign for the picker (and to validate the URL scope).
  const [{ data: agentRows }, { data: campaignRows }] = await Promise.all([
    supabase.from("agents").select("id, name").order("name"),
    supabase.from("campaigns").select("id, name").order("name"),
  ]);
  const agents = (agentRows ?? []) as { id: string; name: string }[];
  const campaigns = (campaignRows ?? []) as { id: string; name: string }[];

  // Parse + validate the scope. A stale id (deleted agent/campaign) falls back
  // to All so the page never errors on an old link.
  let scope = parseScopeParam(str(params.scope));
  let scopeLabel = "All agents (combined)";
  if (scope.kind === "agent") {
    const found = agents.find((a) => a.id === scope.agentId);
    if (found) scopeLabel = found.name;
    else scope = { kind: "all" };
  } else if (scope.kind === "campaign") {
    const found = campaigns.find((c) => c.id === scope.campaignId);
    if (found) scopeLabel = found.name;
    else scope = { kind: "all" };
  }
  const scopeParam = serializeScope(scope);

  // The interest tabs (Voice of Customer, Hot Leads) only show when the scope
  // has yes/no/maybe data.
  const showInterest = await hasInterestData(supabase, scope);
  const visibleTabs = reportingTabsFor(showInterest);
  const tab = visibleTabs.some((t) => t.key === str(params.tab))
    ? str(params.tab)
    : "dashboard";

  // Map the scope to the dashboard-kpi args (all mode, or agent+its campaigns,
  // or one campaign).
  const kpiScope =
    scope.kind === "all"
      ? { all: true }
      : scope.kind === "agent"
        ? {
            agentId: scope.agentId,
            campaignIds: await fetchAgentCampaignIds(supabase, scope.agentId),
          }
        : { campaignIds: [scope.campaignId] };

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
            For upper-management reporting — agent performance, call results,
            and app changes. Pick an agent or campaign to scope the view.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ScopePicker
            agents={agents}
            campaigns={campaigns}
            value={scopeParam}
          />
          {shareToken ? <CopyShareLinkButton token={shareToken} /> : null}
        </div>
      </div>

      <ReportingTabs
        active={tab}
        tabs={visibleTabs}
        hrefFor={(k) => `/reporting?tab=${k}&scope=${scopeParam}`}
      />

      {tab === "dashboard" ? (
        <DashboardTab
          kpiScope={kpiScope}
          selectedDay={str(params.day)}
          scopeParam={scopeParam}
          slug={slug}
        />
      ) : tab === "voice" ? (
        <VoiceTab scope={scope} slug={slug} />
      ) : tab === "hot-leads" ? (
        <HotLeadsTab slug={slug} />
      ) : tab === "changelog" ? (
        <ChangelogTab />
      ) : tab === "prompt-log" ? (
        <PromptLogTab />
      ) : null}
    </div>
  );
}

async function DashboardTab({
  kpiScope,
  selectedDay,
  scopeParam,
  slug,
}: {
  kpiScope: { all?: boolean; agentId?: string | null; campaignIds?: string[] };
  selectedDay: string;
  scopeParam: string;
  slug: string;
}) {
  const supabase = await createClient();
  const kpis = await fetchDashboardKpis(supabase, kpiScope);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(selectedDay)
    ? selectedDay
    : yesterdayEt();
  // Per-day operator notes (admin-only; not passed to the public share).
  const { data: noteRows } = await supabase
    .from("dashboard_notes")
    .select("day, note");
  const notes: Record<string, string> = {};
  for (const r of noteRows ?? []) notes[r.day] = r.note;
  return (
    <DashboardView
      kpis={kpis}
      day={day}
      historyDays={DASHBOARD_DAYS}
      dayHrefFor={(d) =>
        `/reporting?tab=dashboard&scope=${scopeParam}&day=${d}`
      }
      notes={notes}
      notesEditable
      scopeSlug={slug}
    />
  );
}

async function VoiceTab({ scope, slug }: { scope: ReportScope; slug: string }) {
  const supabase = await createClient();
  return (
    <VoiceTable rows={await fetchVoiceRows(supabase, scope)} scopeSlug={slug} />
  );
}

async function HotLeadsTab({ slug }: { slug: string }) {
  const supabase = await createClient();
  return (
    <HotLeadsTable rows={await fetchHotLeadRows(supabase)} scopeSlug={slug} />
  );
}

async function ChangelogTab() {
  const supabase = await createClient();
  const rows = await fetchChangelogRows(supabase);
  return <ChangelogTable key={rows.map((r) => r.id).join(",")} rows={rows} />;
}

async function PromptLogTab() {
  const supabase = await createClient();
  const rows = await fetchPromptLogRows(supabase);
  return <PromptLogTable key={rows.map((r) => r.id).join(",")} rows={rows} />;
}
