import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import {
  detectCampaignFields,
  isWarm,
  type DetectedFields,
} from "@/lib/agent-analytics/field-detect";
import { yesterdayEt } from "@/lib/agent-analytics/stats";
import {
  DASHBOARD_DAYS,
  fetchChangelogRows,
  fetchDashboardKpis,
  fetchHotLeadRows,
  fetchPromptLogRows,
  fetchVoiceRows,
  type DashboardKpiScope,
} from "@/lib/agent-analytics/report-data";
import {
  parseScopeParam,
  serializeScope,
  type ReportScope,
} from "@/lib/agent-analytics/scope";
import { fetchReviewBuckets, fetchCandidateFlags } from "@/lib/review/buckets";

import { CallReviewTable } from "./call-review-table";
import { SuggestedFlagsPanel } from "./suggested-flags-panel";
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
  if (me?.role !== "admin") redirect("/");

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
  const showVoice = scope.kind === "campaign" && detected.sentimentKey !== null;
  const showHotLeads =
    scope.kind === "campaign" &&
    detected.sentimentKey !== null &&
    detected.sentimentValues.some(isWarm);
  const visibleTabs = reportingTabsFor({ showVoice, showHotLeads });
  const tab = visibleTabs.some((t) => t.key === str(params.tab))
    ? str(params.tab)
    : "dashboard";

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
            For upper-management reporting — agent performance, call results,
            and app changes. Pick a campaign to scope the view.
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

      {tab === "dashboard" ? (
        <DashboardTab
          kpiScope={kpiScope}
          selectedDay={str(params.day)}
          scopeParam={scopeParam}
          slug={slug}
          sentimentKey={detected.sentimentKey}
          sentimentValues={detected.sentimentValues}
        />
      ) : tab === "call-review" ? (
        <CallReviewTab />
      ) : tab === "voice" ? (
        <VoiceTab scope={scope} detected={detected} slug={slug} />
      ) : tab === "hot-leads" ? (
        <HotLeadsTab scope={scope} detected={detected} slug={slug} />
      ) : tab === "changelog" ? (
        <ChangelogTab />
      ) : tab === "prompt-log" ? (
        <PromptLogTab scope={scope} agents={agents} />
      ) : null}
    </div>
  );
}

async function DashboardTab({
  kpiScope,
  selectedDay,
  scopeParam,
  slug,
  sentimentKey,
  sentimentValues,
}: {
  kpiScope: DashboardKpiScope;
  selectedDay: string;
  scopeParam: string;
  slug: string;
  sentimentKey: string | null;
  sentimentValues: string[];
}) {
  const supabase = await createClient();
  const kpis = await fetchDashboardKpis(supabase, kpiScope, sentimentKey);
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
      sentimentValues={sentimentValues}
    />
  );
}

async function CallReviewTab() {
  const supabase = await createClient();
  const [{ summary, buckets }, candidates] = await Promise.all([
    fetchReviewBuckets(supabase),
    fetchCandidateFlags(supabase),
  ]);
  return (
    <div className="flex flex-col gap-5">
      <SuggestedFlagsPanel candidates={candidates} />
      <CallReviewTable summary={summary} buckets={buckets} />
    </div>
  );
}

async function VoiceTab({
  scope,
  detected,
  slug,
}: {
  scope: ReportScope;
  detected: DetectedFields;
  slug: string;
}) {
  const supabase = await createClient();
  return (
    <VoiceTable
      rows={await fetchVoiceRows(supabase, scope, detected)}
      sentimentValues={detected.sentimentValues}
      recordingBase="/api/reporting/recording"
      scopeSlug={slug}
    />
  );
}

async function HotLeadsTab({
  scope,
  detected,
  slug,
}: {
  scope: ReportScope;
  detected: DetectedFields;
  slug: string;
}) {
  const supabase = await createClient();
  return (
    <HotLeadsTable
      rows={await fetchHotLeadRows(supabase, scope, detected)}
      scopeSlug={slug}
    />
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
