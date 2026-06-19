import { redirect } from "next/navigation";
import Link from "next/link";

import { createClient } from "@/lib/supabase/server";
import {
  computeDailyKpis,
  etDay,
  interestOf,
  sinceDaysAgoIso,
  yesterdayEt,
  type AgentCallRow,
} from "@/lib/agent-analytics/stats";

import { ChangelogTable, type ChangelogRow } from "./changelog-table";
import { DashboardView } from "./dashboard-view";
import { HotLeadsTable, type HotLeadRow } from "./hot-leads-table";
import { PromptLogTable, type PromptLogRow } from "./prompt-log-table";
import { VoiceTable, type VoiceRow } from "./voice-table";

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
const VOICE_DAYS = 30;

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

type VoiceRawRow = {
  id: string;
  started_at: string | null;
  extracted_data: unknown;
  theme: string | null;
  suggested_action: string | null;
  lead: unknown;
};

function leadInfo(lead: unknown): { company: string; list: string } {
  const l = Array.isArray(lead) ? lead[0] : lead;
  const obj = l && typeof l === "object" ? (l as Record<string, unknown>) : {};
  const company = typeof obj.company === "string" ? obj.company : "";
  const listRaw = Array.isArray(obj.list) ? obj.list[0] : obj.list;
  const listObj =
    listRaw && typeof listRaw === "object"
      ? (listRaw as Record<string, unknown>)
      : {};
  const list = typeof listObj.name === "string" ? listObj.name : "";
  return { company, list };
}

async function VoiceTab({ agentId }: { agentId: string }) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("calls")
    .select(
      "id, started_at, extracted_data, theme, suggested_action, lead:leads(company, list:lists(name))",
    )
    .eq("agent_id", agentId)
    .eq("direction", "outbound")
    .gte("started_at", sinceDaysAgoIso(VOICE_DAYS))
    .not("extracted_data->>ai_call_answering_interest", "is", null)
    .order("started_at", { ascending: false })
    .limit(2000);

  const rows: VoiceRow[] = ((data ?? []) as unknown as VoiceRawRow[])
    .map((r): VoiceRow | null => {
      const interest = interestOf({
        started_at: r.started_at,
        outcome: null,
        duration_seconds: null,
        extracted_data: r.extracted_data,
      });
      if (!interest) return null; // belt-and-suspenders vs the DB JSON filter
      const ed =
        r.extracted_data && typeof r.extracted_data === "object"
          ? (r.extracted_data as Record<string, unknown>)
          : {};
      const reason =
        typeof ed.ai_call_answering_reason === "string"
          ? ed.ai_call_answering_reason
          : "";
      const { company, list } = leadInfo(r.lead);
      return {
        id: r.id,
        day: r.started_at ? etDay(r.started_at) : "",
        company,
        list,
        interest,
        reason,
        theme: r.theme ?? "",
        suggestedAction: r.suggested_action ?? "",
      };
    })
    .filter((r): r is VoiceRow => r !== null);

  return <VoiceTable rows={rows} />;
}

type HotLeadRawRow = {
  id: string;
  session_date: string | null;
  contact_name: string | null;
  why_hot: string | null;
  call_length_seconds: number | null;
  current_ai_tool: string | null;
  status: string | null;
  owner: string | null;
  next_step: string | null;
  date_contacted: string | null;
  lead: unknown;
};

function fmtLen(s: number | null): string {
  if (!s || s <= 0) return "";
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

async function HotLeadsTab() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("hot_leads")
    .select(
      "id, session_date, contact_name, why_hot, call_length_seconds, current_ai_tool, status, owner, next_step, date_contacted, lead:leads(company)",
    )
    .order("session_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(2000);

  const rows: HotLeadRow[] = ((data ?? []) as unknown as HotLeadRawRow[]).map(
    (r) => ({
      id: r.id,
      sessionDate: r.session_date ?? "",
      company: leadInfo(r.lead).company,
      contactName: r.contact_name ?? "",
      whyHot: r.why_hot ?? "",
      callLength: fmtLen(r.call_length_seconds),
      currentAiTool: r.current_ai_tool ?? "",
      status: r.status ?? "New",
      owner: r.owner ?? "",
      nextStep: r.next_step ?? "",
      dateContacted: r.date_contacted ?? "",
    }),
  );

  return <HotLeadsTable rows={rows} />;
}

async function ChangelogTab() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("app_changelog")
    .select(
      "id, change_date, area, change_type, summary, details, status, owner, ticket_link",
    )
    .order("change_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(2000);

  const rows: ChangelogRow[] = (data ?? []).map((r) => ({
    id: r.id,
    changeDate: r.change_date ?? "",
    area: r.area ?? "",
    changeType: r.change_type ?? "",
    summary: r.summary ?? "",
    details: r.details ?? "",
    status: r.status ?? "Open",
    owner: r.owner ?? "",
    ticketLink: r.ticket_link ?? "",
  }));

  return <ChangelogTable key={rows.map((r) => r.id).join(",")} rows={rows} />;
}

async function PromptLogTab() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("agent_prompt_log")
    .select("id, log_date, version, changed, what_changed, why, full_prompt")
    .order("log_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(2000);

  const raw = data ?? [];
  const rows: PromptLogRow[] = raw.map((r, i) => {
    // The diff baseline is the next-older entry that actually has a prompt.
    let prevPrompt = "";
    for (let j = i + 1; j < raw.length; j++) {
      const fp = raw[j].full_prompt;
      if (fp && fp.trim()) {
        prevPrompt = fp;
        break;
      }
    }
    return {
      id: r.id,
      logDate: r.log_date ?? "",
      version: r.version ?? "",
      changed: r.changed ?? "No change",
      whatChanged: r.what_changed ?? "",
      why: r.why ?? "",
      fullPrompt: r.full_prompt ?? "",
      prevPrompt,
    };
  });

  return <PromptLogTable key={rows.map((r) => r.id).join(",")} rows={rows} />;
}
