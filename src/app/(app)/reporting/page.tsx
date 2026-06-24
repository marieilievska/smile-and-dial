import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { yesterdayEt } from "@/lib/agent-analytics/stats";
import {
  DASHBOARD_DAYS,
  fetchChangelogRows,
  fetchDashboardKpis,
  fetchHotLeadRows,
  fetchPromptLogRows,
  fetchVoiceRows,
} from "@/lib/agent-analytics/report-data";

import { ChangelogTable } from "./changelog-table";
import { CopyShareLinkButton } from "./copy-share-link-button";
import { DashboardView } from "./dashboard-view";
import { HotLeadsTable } from "./hot-leads-table";
import { PromptLogTable } from "./prompt-log-table";
import { REPORTING_TABS, ReportingTabs } from "./reporting-tabs";
import { VoiceTable } from "./voice-table";

function str(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
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

  const tab = REPORTING_TABS.some((t) => t.key === str(params.tab))
    ? str(params.tab)
    : "dashboard";

  // Scope to the Market Research agent.
  const { data: agent } = await supabase
    .from("agents")
    .select("id, name")
    .ilike("name", "%market research%")
    .maybeSingle();

  // Also resolve the Market Research campaign(s) by name. The dashboard counts
  // by campaign as well, so the numbers survive even if the agent is later
  // deleted (calls keep their campaign_id; only agent_id goes null).
  const { data: campaignRows } = await supabase
    .from("campaigns")
    .select("id")
    .ilike("name", "%market research%");
  const campaignIds = (campaignRows ?? []).map((c) => c.id);

  // Public read-only share token (revocable from settings). When set, admins
  // get a "Copy share link" button; when blank, the link is disabled so we
  // hide the button.
  const { data: shareRow } = await supabase
    .from("app_settings")
    .select("agent_analytics_share_token")
    .eq("id", 1)
    .maybeSingle();
  const shareToken = shareRow?.agent_analytics_share_token ?? "";

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            Reporting
          </h1>
          <p className="text-muted-foreground mt-0.5 text-sm">
            For upper-management reporting — agent performance, call results,
            and app changes. Currently covering the Market Research agent.
          </p>
        </div>
        {shareToken ? <CopyShareLinkButton token={shareToken} /> : null}
      </div>

      <ReportingTabs active={tab} hrefFor={(k) => `/reporting?tab=${k}`} />

      {!agent && campaignIds.length === 0 ? (
        <div className="border-border bg-muted/20 rounded-lg border p-6 text-sm">
          No agent or campaign named “Market Research” was found, so there’s
          nothing to report yet.
        </div>
      ) : tab === "dashboard" ? (
        <DashboardTab
          agentId={agent?.id ?? null}
          campaignIds={campaignIds}
          selectedDay={str(params.day)}
        />
      ) : tab === "voice" ? (
        agent ? (
          <VoiceTab agentId={agent.id} />
        ) : (
          <div className="border-border bg-muted/20 rounded-lg border p-6 text-sm">
            The Market Research agent was removed, so per-call detail isn’t
            available here. The dashboard counts (by campaign) and Costs /
            Analytics still cover this campaign.
          </div>
        )
      ) : tab === "hot-leads" ? (
        <HotLeadsTab />
      ) : tab === "changelog" ? (
        <ChangelogTab />
      ) : tab === "prompt-log" ? (
        <PromptLogTab />
      ) : null}
    </div>
  );
}

async function DashboardTab({
  agentId,
  campaignIds,
  selectedDay,
}: {
  agentId: string | null;
  campaignIds: string[];
  selectedDay: string;
}) {
  const supabase = await createClient();
  const kpis = await fetchDashboardKpis(supabase, { agentId, campaignIds });
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
      dayHrefFor={(d) => `/reporting?tab=dashboard&day=${d}`}
      notes={notes}
      notesEditable
    />
  );
}

async function VoiceTab({ agentId }: { agentId: string }) {
  const supabase = await createClient();
  return <VoiceTable rows={await fetchVoiceRows(supabase, agentId)} />;
}

async function HotLeadsTab() {
  const supabase = await createClient();
  return <HotLeadsTable rows={await fetchHotLeadRows(supabase)} />;
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
