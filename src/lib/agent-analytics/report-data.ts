// Shared data layer for the Reporting page. Every fetch takes a Supabase
// client so the SAME query + mapping serves both the in-app admin page (auth
// client) and the public token-gated share page (service-role client) — the
// two can never drift. Row types live here too so the client table components
// import them type-only.

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  computeCauseOfDeath,
  type CauseKey,
  type CauseResult,
  type LeadForCause,
} from "@/lib/agent-analytics/cause-of-death";
import type { ObjectionRow } from "@/lib/agent-analytics/objections";
import type { ObjectionCategory } from "@/lib/openai/objection-extractor";
import { chunk } from "@/lib/leads/chunk";
import type { Database } from "@/lib/supabase/database.types";
import { fetchAllRows } from "@/lib/supabase/fetch-all-rows";

import { isWarm, type DetectedFields } from "./field-detect";
import type { ReportScope } from "./scope";
import {
  computeDailyKpis,
  etDay,
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
  leadId: string | null;
  /** The campaign's sentiment value, lowercased (e.g. "yes", "happy"). */
  sentiment: string;
  /** The campaign's free-text notes answer. */
  notes: string;
  /** Storage object path or legacy http(s) URL; null when no recording. */
  recordingPath: string | null;
};

export type HotLeadRow = {
  id: string; // call id
  day: string;
  company: string;
  contact: string;
  whyHot: string;
  list: string;
  leadId: string | null;
};

export type ChangelogRow = {
  id: string;
  changeDate: string;
  area: string;
  changeType: string;
  summary: string;
  details: string;
  status: string;
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
  agentId: string | null;
  agentName: string;
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

function leadInfo(lead: unknown): {
  company: string;
  contact: string;
  list: string;
} {
  const l = Array.isArray(lead) ? lead[0] : lead;
  const obj = l && typeof l === "object" ? (l as Record<string, unknown>) : {};
  const s = (k: string) =>
    typeof obj[k] === "string" ? (obj[k] as string).trim() : "";
  const company = s("company");
  const contact = s("owner_name") || s("manager_name") || s("employee_name");
  const listRaw = Array.isArray(obj.list) ? obj.list[0] : obj.list;
  const listObj =
    listRaw && typeof listRaw === "object"
      ? (listRaw as Record<string, unknown>)
      : {};
  const list = typeof listObj.name === "string" ? listObj.name : "";
  return { company, contact, list };
}

// --- Fetchers --------------------------------------------------------------

export type DashboardKpiScope = { all?: boolean; campaignIds?: string[] };

export async function fetchDashboardKpis(
  supabase: DB,
  scope: DashboardKpiScope,
  sentimentKey?: string | null,
): Promise<DailyKpi[]> {
  // Count by the agent AND/OR the campaign(s). `calls.agent_id` goes NULL if the
  // agent is deleted, but `calls.campaign_id` is durable — so matching on either
  // keeps the dashboard accurate even after an agent is removed.
  const conds: string[] = [];
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
      .select("created_at, outcome, duration_seconds, extracted_data, lead_id")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .range(offset, offset + PAGE - 1);
    // All-agents mode counts every call (outbound AND inbound — a returned
    // missed call is a call, per Marija 2026-09-03); scoped mode narrows by
    // agent/campaign.
    if (!scope.all) q = q.or(conds.join(","));
    const { data } = await q;
    const batch = (data ?? []) as AgentCallRow[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
    if (offset > 500_000) break; // safety backstop
  }
  return computeDailyKpis(rows, sentimentKey);
}

/** Cause of death: for every lead with ≥1 call in the dashboard window
 *  (scoped), the single primary reason it isn't won. Pages the calls query
 *  around the 1,000-row cap, then chunk-loads the leads' status/dm flag. */
export async function fetchCauseOfDeath(
  supabase: DB,
  scope: DashboardKpiScope,
): Promise<{
  result: CauseResult;
  companyByLead: Record<string, string>;
  /** Objection rows grouped by the loss cause they belong to. The objection
   *  engine extracts objections for every reached-a-person outcome, so both
   *  "Decision-maker said no" AND "Gatekeeper wall" get a why-breakdown. */
  objectionsByCause: Partial<Record<CauseKey, ObjectionRow[]>>;
}> {
  const conds: string[] = [];
  if (scope.campaignIds && scope.campaignIds.length > 0) {
    conds.push(`campaign_id.in.(${scope.campaignIds.join(",")})`);
  }
  if (!scope.all && conds.length === 0) {
    return {
      result: computeCauseOfDeath([]),
      companyByLead: {},
      objectionsByCause: {},
    };
  }

  // (a) Page every in-window call (any direction) → per-lead outcome set + goalMet +
  //     the lead's objection (first call, in paged order, that carries one).
  type LeadObjection = {
    category: ObjectionCategory;
    specific: string | null;
    quote: string | null;
  };
  const PAGE = 1000;
  const since = sinceDaysAgoIso(DASHBOARD_DAYS);
  const byLead = new Map<
    string,
    { outcomes: string[]; goalMet: boolean; objection: LeadObjection | null }
  >();
  for (let offset = 0; ; offset += PAGE) {
    let q = supabase
      .from("calls")
      .select(
        "lead_id, outcome, goal_met, objection_category, objection_specific, objection_quote",
      )
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .range(offset, offset + PAGE - 1);
    if (!scope.all) q = q.or(conds.join(","));
    const { data } = await q;
    const batch = (data ?? []) as {
      lead_id: string | null;
      outcome: string | null;
      goal_met: boolean | null;
      objection_category: string | null;
      objection_specific: string | null;
      objection_quote: string | null;
    }[];
    for (const row of batch) {
      if (!row.lead_id) continue;
      const entry = byLead.get(row.lead_id) ?? {
        outcomes: [],
        goalMet: false,
        objection: null,
      };
      if (row.outcome) entry.outcomes.push(row.outcome);
      if (row.goal_met) entry.goalMet = true;
      // First non-null objection (in paged order) wins for the lead.
      if (!entry.objection && row.objection_category) {
        entry.objection = {
          category: row.objection_category as ObjectionCategory,
          specific: row.objection_specific,
          quote: row.objection_quote,
        };
      }
      byLead.set(row.lead_id, entry);
    }
    if (batch.length < PAGE) break;
    if (offset > 500_000) break; // safety backstop
  }

  const leadIds = [...byLead.keys()];
  if (leadIds.length === 0) {
    return {
      result: computeCauseOfDeath([]),
      companyByLead: {},
      objectionsByCause: {},
    };
  }

  // (b) Chunk-load the leads' status + DM flag + company (200 ids/request).
  const leadMeta = new Map<
    string,
    { status: string; dm: boolean; company: string }
  >();
  for (const ids of chunk(leadIds, 200)) {
    const { data } = await supabase
      .from("leads")
      .select("id, status, decision_maker_reached, company")
      .in("id", ids);
    for (const l of (data ?? []) as {
      id: string;
      status: string | null;
      decision_maker_reached: boolean | null;
      company: string | null;
    }[]) {
      leadMeta.set(l.id, {
        status: l.status ?? "",
        dm: l.decision_maker_reached === true,
        company: l.company ?? "",
      });
    }
  }

  // (c) Build LeadForCause[] and aggregate.
  const leads: LeadForCause[] = [];
  const companyByLead: Record<string, string> = {};
  for (const [leadId, agg] of byLead) {
    const meta = leadMeta.get(leadId);
    if (!meta) continue; // lead deleted since the call — skip
    companyByLead[leadId] = meta.company;
    leads.push({
      leadId,
      status: meta.status,
      decisionMakerReached: meta.dm,
      goalMet: agg.goalMet,
      outcomes: agg.outcomes,
    });
  }

  const result = computeCauseOfDeath(leads);

  // (d) Objection rows grouped by cause — dm_said_no AND gatekeeper both carry
  //     objections (the engine analyzes every reached-a-person outcome).
  const objectionsByCause: Partial<Record<CauseKey, ObjectionRow[]>> = {};
  for (const { leadId, cause } of result.perLead) {
    if (cause !== "dm_said_no" && cause !== "gatekeeper") continue;
    const objection = byLead.get(leadId)?.objection;
    if (!objection) continue;
    (objectionsByCause[cause] ??= []).push({
      leadId,
      company: companyByLead[leadId] ?? "",
      category: objection.category,
      specific: objection.specific,
      quote: objection.quote,
    });
  }

  return { result, companyByLead, objectionsByCause };
}

export async function fetchVoiceRows(
  supabase: DB,
  scope: ReportScope,
  detected: DetectedFields,
): Promise<VoiceRow[]> {
  if (scope.kind !== "campaign" || !detected.sentimentKey) return [];
  const sentimentKey = detected.sentimentKey;
  type Raw = {
    id: string;
    created_at: string | null;
    lead_id: string | null;
    extracted_data: unknown;
    recording_path: string | null;
    lead: unknown;
  };
  // Paged: a `.limit(2000)` here was silently clamped to 1,000 by PostgREST, so
  // the "All (N)" pill and every sentiment count were of a truncated set.
  const data = await fetchAllRows<Raw>((from, to) =>
    supabase
      .from("calls")
      .select(
        "id, created_at, lead_id, extracted_data, recording_path, lead:leads(company, list:lists(name))",
      )
      .eq("campaign_id", scope.campaignId)
      .gte("created_at", sinceDaysAgoIso(VOICE_DAYS))
      .not(`extracted_data->>${sentimentKey}`, "is", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to)
      .then((r) => ({ data: r.data as unknown as Raw[] | null })),
  );
  return data
    .map((r): VoiceRow | null => {
      const ed =
        r.extracted_data && typeof r.extracted_data === "object"
          ? (r.extracted_data as Record<string, unknown>)
          : {};
      const sentiment = String(ed[sentimentKey] ?? "")
        .trim()
        .toLowerCase();
      if (!sentiment) return null; // belt-and-suspenders vs the DB JSON filter
      const notes = detected.notesKey
        ? String(ed[detected.notesKey] ?? "").trim()
        : "";
      const { company, list } = leadCompany(r.lead);
      return {
        id: r.id,
        day: r.created_at ? etDay(r.created_at) : "",
        company,
        list,
        leadId: r.lead_id,
        sentiment,
        notes,
        recordingPath: r.recording_path,
      };
    })
    .filter((r): r is VoiceRow => r !== null);
}

export async function fetchHotLeadRows(
  supabase: DB,
  scope: ReportScope,
  detected: DetectedFields,
): Promise<HotLeadRow[]> {
  if (scope.kind !== "campaign" || !detected.sentimentKey) return [];
  const warmValues = detected.sentimentValues.filter(isWarm);
  if (warmValues.length === 0) return [];
  const sentimentKey = detected.sentimentKey;

  type Raw = {
    id: string;
    created_at: string | null;
    lead_id: string | null;
    extracted_data: unknown;
    lead: unknown;
  };
  // Paged past PostgREST's 1,000-row cap (the old `.limit(2000)` never
  // returned more than 1,000, so warm leads past that silently vanished).
  const rows = await fetchAllRows<Raw>((from, to) =>
    supabase
      .from("calls")
      .select(
        "id, created_at, lead_id, extracted_data, lead:leads(company, owner_name, manager_name, employee_name, list:lists(name))",
      )
      .eq("campaign_id", scope.campaignId)
      .gte("created_at", sinceDaysAgoIso(VOICE_DAYS))
      .in(`extracted_data->>${sentimentKey}`, warmValues)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to)
      .then((r) => ({ data: r.data as unknown as Raw[] | null })),
  );
  if (rows.length === 0) return [];

  // Exclude dismissed calls (chunk the id lookup past the 1,000-row cap).
  const ids = rows.map((r) => r.id);
  const dismissed = new Set<string>();
  for (let i = 0; i < ids.length; i += 1000) {
    const { data: dis } = await supabase
      .from("hot_lead_dismissals")
      .select("call_id")
      .in("call_id", ids.slice(i, i + 1000));
    for (const d of dis ?? [])
      dismissed.add((d as { call_id: string }).call_id);
  }

  return rows
    .filter((r) => !dismissed.has(r.id))
    .map((r): HotLeadRow => {
      const ed =
        r.extracted_data && typeof r.extracted_data === "object"
          ? (r.extracted_data as Record<string, unknown>)
          : {};
      const info = leadInfo(r.lead);
      return {
        id: r.id,
        day: r.created_at ? etDay(r.created_at) : "",
        company: info.company,
        contact: info.contact,
        whyHot: detected.notesKey
          ? String(ed[detected.notesKey] ?? "").trim()
          : "",
        list: info.list,
        leadId: r.lead_id,
      };
    });
}

export async function fetchChangelogRows(
  supabase: DB,
): Promise<ChangelogRow[]> {
  const { data } = await supabase
    .from("app_changelog")
    .select(
      "id, change_date, area, change_type, summary, details, status, ticket_link",
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
    ticketLink: r.ticket_link ?? "",
  }));
}

export async function fetchPromptLogRows(
  supabase: DB,
  scope: ReportScope,
): Promise<PromptLogRow[]> {
  // Campaign scope → that campaign's agent only; combined → all agents.
  let agentId: string | null = null;
  if (scope.kind === "campaign") {
    const { data: c } = await supabase
      .from("campaigns")
      .select("agent_id")
      .eq("id", scope.campaignId)
      .maybeSingle();
    agentId = c?.agent_id ?? null;
    if (!agentId) return [];
  }

  let q = supabase
    .from("agent_prompt_log")
    .select(
      "id, log_date, version, changed, what_changed, why, full_prompt, agent_id, agent:agents(name)",
    )
    .order("log_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(2000);
  if (agentId) q = q.eq("agent_id", agentId);
  const { data } = await q;

  type Raw = {
    id: string;
    log_date: string | null;
    version: string | null;
    changed: string | null;
    what_changed: string | null;
    why: string | null;
    full_prompt: string | null;
    agent_id: string | null;
    agent: unknown;
  };
  const raw = (data ?? []) as unknown as Raw[];
  return raw.map((r, i): PromptLogRow => {
    // Diff baseline = the next-older entry FOR THE SAME AGENT that has a prompt.
    let prevPrompt = "";
    for (let j = i + 1; j < raw.length; j++) {
      if (raw[j].agent_id !== r.agent_id) continue;
      const fp = raw[j].full_prompt;
      if (fp && fp.trim()) {
        prevPrompt = fp;
        break;
      }
    }
    const a = Array.isArray(r.agent) ? r.agent[0] : r.agent;
    const agentName =
      a &&
      typeof a === "object" &&
      typeof (a as { name?: unknown }).name === "string"
        ? (a as { name: string }).name
        : "";
    return {
      id: r.id,
      logDate: r.log_date ?? "",
      version: r.version ?? "",
      changed: r.changed ?? "No change",
      whatChanged: r.what_changed ?? "",
      why: r.why ?? "",
      fullPrompt: r.full_prompt ?? "",
      prevPrompt,
      agentId: r.agent_id,
      agentName,
    };
  });
}
