import { redirect } from "next/navigation";
import Link from "next/link";

import { createClient } from "@/lib/supabase/server";
import {
  computeDailyKpis,
  sinceDaysAgoIso,
  yesterdayEt,
  type AgentCallRow,
  type DailyKpi,
} from "@/lib/agent-analytics/stats";

import { KpiTile } from "../analytics/kpi-tile";
import { ExportCsvButton } from "./export-csv-button";

function str(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}
function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
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
  const sel: DailyKpi = kpis.find((k) => k.day === day) ?? {
    day,
    callsMade: 0,
    connected: 0,
    convGt1min: 0,
    dms: 0,
    callbacks: 0,
    callbackLater: 0,
    goals: 0,
    notInterested: 0,
    gatekeeper: 0,
    hungUp: 0,
    aiError: 0,
    dnc: 0,
    interestYes: 0,
    interestMaybe: 0,
    interestNo: 0,
    warmPct: 0,
  };

  const exportRows = kpis.map((k) => [
    k.day,
    k.callsMade,
    k.connected,
    k.convGt1min,
    k.dms,
    k.callbacks,
    k.callbackLater,
    k.goals,
    k.notInterested,
    k.gatekeeper,
    k.hungUp,
    k.aiError,
    k.dnc,
    k.interestYes,
    k.interestMaybe,
    k.interestNo,
    pct(k.warmPct),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <p className="text-muted-foreground text-sm">
        KPIs for <span className="text-foreground font-medium">{day}</span>{" "}
        (Eastern). History below covers the last {HISTORY_DAYS} days.
      </p>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
        <KpiTile label="Calls made" value={sel.callsMade.toLocaleString()} />
        <KpiTile label="Connected" value={sel.connected.toLocaleString()} />
        <KpiTile
          label="Conversations >1 min"
          value={sel.convGt1min.toLocaleString()}
        />
        <KpiTile label="DMs reached" value={sel.dms.toLocaleString()} />
        <KpiTile label="Callbacks" value={sel.callbacks.toLocaleString()} />
        <KpiTile label="Goals met" value={sel.goals.toLocaleString()} />
        <KpiTile label="Warm %" value={pct(sel.warmPct)} />
      </section>

      <section className="border-border bg-card flex flex-col gap-3 rounded-xl border p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-foreground text-sm font-semibold">
            Daily history
          </h2>
          <ExportCsvButton
            filename={`market-research-kpis.csv`}
            headers={[
              "day",
              "calls_made",
              "connected",
              "conversations_gt1min",
              "dms_reached",
              "callbacks",
              "callback_later",
              "goals_met",
              "not_interested",
              "gatekeeper",
              "hung_up",
              "ai_error",
              "dnc",
              "interest_yes",
              "interest_maybe",
              "interest_no",
              "warm_pct",
            ]}
            rows={exportRows}
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground border-border border-b text-left text-xs">
                {[
                  "Day",
                  "Calls",
                  "Conn.",
                  ">1m",
                  "DMs",
                  "CB",
                  "CB later",
                  "Goals",
                  "Not int.",
                  "Gatekpr",
                  "Hung up",
                  "AI err",
                  "DNC",
                  "Yes",
                  "Maybe",
                  "No",
                  "Warm %",
                ].map((h) => (
                  <th
                    key={h}
                    className="px-2 py-2 font-medium whitespace-nowrap"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {kpis.length === 0 ? (
                <tr>
                  <td
                    colSpan={17}
                    className="text-muted-foreground px-2 py-6 text-center"
                  >
                    No calls in the last {HISTORY_DAYS} days.
                  </td>
                </tr>
              ) : (
                kpis.map((k) => (
                  <tr key={k.day} className="border-border/60 border-b">
                    <td className="px-2 py-1.5 font-medium whitespace-nowrap">
                      {k.day}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums">{k.callsMade}</td>
                    <td className="px-2 py-1.5 tabular-nums">{k.connected}</td>
                    <td className="px-2 py-1.5 tabular-nums">{k.convGt1min}</td>
                    <td className="px-2 py-1.5 tabular-nums">{k.dms}</td>
                    <td className="px-2 py-1.5 tabular-nums">{k.callbacks}</td>
                    <td className="px-2 py-1.5 tabular-nums">
                      {k.callbackLater}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums">{k.goals}</td>
                    <td className="px-2 py-1.5 tabular-nums">
                      {k.notInterested}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums">{k.gatekeeper}</td>
                    <td className="px-2 py-1.5 tabular-nums">{k.hungUp}</td>
                    <td className="px-2 py-1.5 tabular-nums">{k.aiError}</td>
                    <td className="px-2 py-1.5 tabular-nums">{k.dnc}</td>
                    <td className="px-2 py-1.5 tabular-nums">
                      {k.interestYes}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums">
                      {k.interestMaybe}
                    </td>
                    <td className="px-2 py-1.5 tabular-nums">{k.interestNo}</td>
                    <td className="px-2 py-1.5 tabular-nums">
                      {pct(k.warmPct)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Placeholder({ label }: { label: string }) {
  return (
    <div className="border-border bg-muted/20 text-muted-foreground rounded-lg border border-dashed p-10 text-center text-sm">
      <p className="text-foreground font-medium">{label}</p>
      <p className="mt-1">This tab is coming in the next update.</p>
    </div>
  );
}
