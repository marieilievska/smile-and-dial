// Shared data layer for the Reporting page. Every fetch takes a Supabase
// client so the SAME query + mapping serves both the in-app admin page (auth
// client) and the public token-gated share page (service-role client) — the
// two can never drift. Row types live here too so the client table components
// import them type-only.

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import type { ReportScope } from "./scope";
import {
  computeDailyKpis,
  etDay,
  interestOf,
  sinceDaysAgoIso,
  type AgentCallRow,
  type DailyKpi,
} from "./stats";

type DB = SupabaseClient<Database>;

const VOICE_DAYS = 30;
export const DASHBOARD_DAYS = 30;

// --- Row shapes (consumed by the client table components) ------------------

export type VoiceRow = {
  id: string;
  day: string;
  company: string;
  list: string;
  interest: "yes" | "no" | "maybe";
  reason: string;
  theme: string;
  suggestedAction: string;
};

export type HotLeadRow = {
  id: string;
  sessionDate: string;
  company: string;
  contactName: string;
  whyHot: string;
  callLength: string;
  currentAiTool: string;
  status: string;
  owner: string;
  nextStep: string;
  dateContacted: string;
};

export type ChangelogRow = {
  id: string;
  changeDate: string;
  area: string;
  changeType: string;
  summary: string;
  details: string;
  status: string;
  owner: string;
  ticketLink: string;
};

export type PromptLogRow = {
  id: string;
  logDate: string;
  version: string;
  changed: string;
  whatChanged: string;
  why: string;
  fullPrompt: string;
  /** The full_prompt of the chronologically previous entry, for the diff. */
  prevPrompt: string;
};

// --- Helpers ---------------------------------------------------------------

function leadCompany(lead: unknown): { company: string; list: string } {
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

function fmtLen(s: number | null): string {
  if (!s || s <= 0) return "";
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// --- Fetchers --------------------------------------------------------------

export type DashboardKpiScope = {
  all?: boolean;
  agentId?: string | null;
  campaignIds?: string[];
};

export async function fetchDashboardKpis(
  supabase: DB,
  scope: DashboardKpiScope,
): Promise<DailyKpi[]> {
  // Count by the agent AND/OR the campaign(s). `calls.agent_id` goes NULL if the
  // agent is deleted, but `calls.campaign_id` is durable — so matching on either
  // keeps the dashboard accurate even after an agent is removed.
  const conds: string[] = [];
  if (scope.agentId) conds.push(`agent_id.eq.${scope.agentId}`);
  if (scope.campaignIds && scope.campaignIds.length > 0) {
    conds.push(`campaign_id.in.(${scope.campaignIds.join(",")})`);
  }
  // No scope and not the all-agents view → nothing to report.
  if (!scope.all && conds.length === 0) return [];

  // Paginate: PostgREST hard-caps every response at 1,000 rows on this project
  // (a bare `.limit(5000)` still returns only 1,000), so a busy window would
  // silently undercount the daily call totals. Page through in 1,000-row batches.
  const PAGE = 1000;
  const since = sinceDaysAgoIso(DASHBOARD_DAYS);
  const rows: AgentCallRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    let q = supabase
      .from("calls")
      .select("started_at, outcome, duration_seconds, extracted_data")
      .eq("direction", "outbound")
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .range(offset, offset + PAGE - 1);
    // All-agents mode counts every outbound call; scoped mode narrows by
    // agent/campaign.
    if (!scope.all) q = q.or(conds.join(","));
    const { data } = await q;
    const batch = (data ?? []) as AgentCallRow[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
    if (offset > 500_000) break; // safety backstop
  }
  return computeDailyKpis(rows);
}

type VoiceRawRow = {
  id: string;
  started_at: string | null;
  extracted_data: unknown;
  theme: string | null;
  suggested_action: string | null;
  lead: unknown;
};

export async function fetchVoiceRows(
  supabase: DB,
  scope: ReportScope,
): Promise<VoiceRow[]> {
  let q = supabase
    .from("calls")
    .select(
      "id, started_at, extracted_data, theme, suggested_action, lead:leads(company, list:lists(name))",
    )
    .eq("direction", "outbound")
    .gte("started_at", sinceDaysAgoIso(VOICE_DAYS))
    .not("extracted_data->>ai_call_answering_interest", "is", null)
    .order("started_at", { ascending: false })
    .limit(2000);
  if (scope.kind === "agent") q = q.eq("agent_id", scope.agentId);
  else if (scope.kind === "campaign") q = q.eq("campaign_id", scope.campaignId);
  const { data } = await q;

  return ((data ?? []) as unknown as VoiceRawRow[])
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
      const { company, list } = leadCompany(r.lead);
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
}

/** True when the scope has at least one call carrying an interest answer
 *  (yes/no/maybe) in the Voice window. Drives whether the interest-based tabs
 *  (Voice of Customer, Hot Leads) render. Cheap: a head-only count, no rows. */
export async function hasInterestData(
  supabase: DB,
  scope: ReportScope,
): Promise<boolean> {
  let q = supabase
    .from("calls")
    .select("id", { count: "exact", head: true })
    .eq("direction", "outbound")
    .gte("started_at", sinceDaysAgoIso(VOICE_DAYS))
    .in("extracted_data->>ai_call_answering_interest", ["yes", "no", "maybe"]);
  if (scope.kind === "agent") q = q.eq("agent_id", scope.agentId);
  else if (scope.kind === "campaign") q = q.eq("campaign_id", scope.campaignId);
  const { count } = await q;
  return (count ?? 0) > 0;
}

/** The campaign ids run by an agent. Passed alongside agentId to
 *  fetchDashboardKpis so totals survive the agent row being deleted later
 *  (calls keep campaign_id; only agent_id goes null). */
export async function fetchAgentCampaignIds(
  supabase: DB,
  agentId: string,
): Promise<string[]> {
  const { data } = await supabase
    .from("campaigns")
    .select("id")
    .eq("agent_id", agentId);
  return (data ?? []).map((c) => (c as { id: string }).id);
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

export async function fetchHotLeadRows(supabase: DB): Promise<HotLeadRow[]> {
  const { data } = await supabase
    .from("hot_leads")
    .select(
      "id, session_date, contact_name, why_hot, call_length_seconds, current_ai_tool, status, owner, next_step, date_contacted, lead:leads(company)",
    )
    .order("session_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(2000);

  return ((data ?? []) as unknown as HotLeadRawRow[]).map((r) => ({
    id: r.id,
    sessionDate: r.session_date ?? "",
    company: leadCompany(r.lead).company,
    contactName: r.contact_name ?? "",
    whyHot: r.why_hot ?? "",
    callLength: fmtLen(r.call_length_seconds),
    currentAiTool: r.current_ai_tool ?? "",
    status: r.status ?? "New",
    owner: r.owner ?? "",
    nextStep: r.next_step ?? "",
    dateContacted: r.date_contacted ?? "",
  }));
}

export async function fetchChangelogRows(
  supabase: DB,
): Promise<ChangelogRow[]> {
  const { data } = await supabase
    .from("app_changelog")
    .select(
      "id, change_date, area, change_type, summary, details, status, owner, ticket_link",
    )
    .order("change_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(2000);

  return (data ?? []).map((r) => ({
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
}

export async function fetchPromptLogRows(
  supabase: DB,
): Promise<PromptLogRow[]> {
  const { data } = await supabase
    .from("agent_prompt_log")
    .select("id, log_date, version, changed, what_changed, why, full_prompt")
    .order("log_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(2000);

  const raw = data ?? [];
  return raw.map((r, i) => {
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
}
