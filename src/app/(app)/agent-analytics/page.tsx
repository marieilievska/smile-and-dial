import { redirect } from "next/navigation";
import Link from "next/link";

import { createClient } from "@/lib/supabase/server";
import {
  computeDailyKpis,
  sinceDaysAgoIso,
  yesterdayEt,
  type AgentCallRow,
} from "@/lib/agent-analytics/stats";

import { DashboardView } from "./dashboard-view";

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

const HISTORY_DAYS = 30;

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
          Agent Analytics
        </h1>
        <p className="text-muted-foreground mt-0.5 text-sm">
          Market Research agent · daily call results, voice of customer, and hot
          leads.
        </p>
      </div>

      {/* Tab bar */}
      <div className="border-border flex flex-wrap gap-1 border-b">
        {TABS.map((t) => {
          const active = t.key === tab;
          return (
            <Link
              key={t.key}
              href={`/agent-analytics?tab=${t.key}`}
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
      ) : (
        <Placeholder label={TABS.find((t) => t.key === tab)?.label ?? ""} />
      )}
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
  const since = sinceDaysAgoIso(HISTORY_DAYS);
  const { data } = await supabase
    .from("calls")
    .select("started_at, outcome, duration_seconds, extracted_data")
    .eq("agent_id", agentId)
    .eq("direction", "outbound")
    .gte("started_at", since)
    .order("started_at", { ascending: false })
    .limit(5000);

  const kpis = computeDailyKpis((data ?? []) as AgentCallRow[]);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(selectedDay)
    ? selectedDay
    : yesterdayEt();
  return <DashboardView kpis={kpis} day={day} historyDays={HISTORY_DAYS} />;
}

function Placeholder({ label }: { label: string }) {
  return (
    <div className="border-border bg-muted/20 text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
      <p className="text-foreground font-medium">{label}</p>
      <p className="mt-1">This tab is coming in the next update.</p>
    </div>
  );
}
