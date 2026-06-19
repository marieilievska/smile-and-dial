import { redirect } from "next/navigation";
import Link from "next/link";

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
import { DashboardView } from "./dashboard-view";
import { HotLeadsTable } from "./hot-leads-table";
import { PromptLogTable } from "./prompt-log-table";
import { VoiceTable } from "./voice-table";

function str(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}

const TABS = [
  { key: "dashboard", label: "Dashboard" },
  { key: "voice", label: "Voice of Customer" },
  { key: "hot-leads", label: "Hot Leads" },
  { key: "changelog", label: "App Changelog" },
  { key: "prompt-log", label: "Agent Prompt Log" },
] as const;

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

  const tab = TABS.some((t) => t.key === str(params.tab))
    ? str(params.tab)
    : "dashboard";

  // Scope to the Market Research agent.
  const { data: agent } = await supabase
    .from("agents")
    .select("id, name")
    .ilike("name", "%market research%")
    .maybeSingle();

  return (
    <div className="flex flex-col gap-5 p-6">
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Reporting
        </h1>
        <p className="text-muted-foreground mt-0.5 text-sm">
          For upper-management reporting — agent performance, call results, and
          app changes. Currently covering the Market Research agent.
        </p>
      </div>

      {/* Tab bar */}
      <div className="border-border flex flex-wrap gap-1 border-b">
        {TABS.map((t) => {
          const active = t.key === tab;
          return (
            <Link
              key={t.key}
              href={`/reporting?tab=${t.key}`}
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
        <div className="border-border bg-muted/20 rounded-lg border p-6 text-sm">
          No agent named “Market Research” was found, so there’s nothing to
          report yet.
        </div>
      ) : tab === "dashboard" ? (
        <DashboardTab agentId={agent.id} selectedDay={str(params.day)} />
      ) : tab === "voice" ? (
        <VoiceTab agentId={agent.id} />
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
  selectedDay,
}: {
  agentId: string;
  selectedDay: string;
}) {
  const supabase = await createClient();
  const kpis = await fetchDashboardKpis(supabase, agentId);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(selectedDay)
    ? selectedDay
    : yesterdayEt();
  return <DashboardView kpis={kpis} day={day} historyDays={DASHBOARD_DAYS} />;
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
