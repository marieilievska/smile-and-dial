// Shared data layer for the Reporting page. Every fetch takes a Supabase
// client so the SAME query + mapping serves both the in-app admin page (auth
// client) and the public token-gated share page (service-role client) — the
// two can never drift. Row types live here too so the client table components
// import them type-only.

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  CAUSE_GROUP,
  NO_CONTACT_LABEL,
  type CauseGroup,
  type CauseKey,
  type NoContactReason,
} from "@/lib/agent-analytics/cause-of-death";
import type { ObjectionRow } from "@/lib/agent-analytics/objections";
import type { Database } from "@/lib/supabase/database.types";
import { fetchAllRows } from "@/lib/supabase/fetch-all-rows";

import type { ReportScope } from "./scope";
import { sinceDaysAgoIso, warmPctOf, type DailyKpi } from "./stats";

type DB = SupabaseClient<Database>;

export const DASHBOARD_DAYS = 30;

// --- Row shapes (consumed by the client table components) ------------------

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

// --- Fetchers --------------------------------------------------------------

export type DashboardKpiScope = { all?: boolean; campaignIds?: string[] };

export async function fetchDashboardKpis(
  supabase: DB,
  scope: DashboardKpiScope,
  sentimentKey?: string | null,
): Promise<DailyKpi[]> {
  // Scoped by campaign. `calls.campaign_id` is durable where `agent_id` goes
  // NULL when an agent is deleted, so the dashboard stays accurate after a
  // removal. All-agents mode counts every call (outbound AND inbound — a
  // returned missed call is a call, per Marija 2026-09-03).
  const campaignIds =
    scope.campaignIds && scope.campaignIds.length > 0
      ? scope.campaignIds
      : null;
  // No scope and not the all-agents view → nothing to report.
  if (!scope.all && !campaignIds) return [];

  // One aggregate instead of paging the window into memory. This used to fetch
  // the last 30 Eastern days of calls 1,000 rows at a time — nine sequential
  // 233 KB requests, each carrying extracted_data — and group them in a
  // for-loop, which was almost all of the dashboard's ~4.7s render
  // (20260907090000).
  // Omitted rather than passed as null: both arguments have a SQL default of
  // null, and the generated Args type models an optional argument as
  // `?: T`, not `T | null`.
  const { data, error } = await supabase.rpc("reporting_daily_kpis", {
    p_since: sinceDaysAgoIso(DASHBOARD_DAYS),
    ...(scope.all || !campaignIds ? {} : { p_campaign_ids: campaignIds }),
    ...(sentimentKey ? { p_sentiment_key: sentimentKey } : {}),
  });
  // Fail loud. Returning [] on error would render a confident, fully-populated
  // dashboard reading zero everywhere.
  if (error) {
    throw new Error(`Reporting daily KPIs failed: ${error.message}`);
  }

  // warmPct is derived HERE, not in SQL: the warm/cold lexicon lives in
  // field-detect.ts and there should be one definition of it.
  return ((data ?? []) as unknown as Omit<DailyKpi, "warmPct">[]).map((d) => ({
    ...d,
    sentimentCounts: d.sentimentCounts ?? {},
    warmPct: warmPctOf(d.sentimentCounts ?? {}),
  }));
}

/** How many company names each cause list carries. The lists live inside a
 *  collapsed <details> in a 224px scroll box, so returning every worked lead is
 *  a megabyte nobody reads; the true count travels alongside so the UI can say
 *  how many were left out. */
export const CAUSE_SAMPLE_CAP = 100;

export type CauseSampleList = { count: number; sample: string[] };

export type CauseSummary = {
  /** Worked leads in the window — leads with at least one call. */
  total: number;
  counts: Record<CauseKey, number>;
  groups: Record<CauseGroup, number>;
  /** Capped, most-recently-called-first company names per cause. */
  samples: Partial<Record<CauseKey, CauseSampleList>>;
  /** The "no real contact" sub-reason breakdown, in precedence order. */
  noContact: { reason: NoContactReason; list: CauseSampleList }[];
  objectionsByCause: Partial<Record<CauseKey, ObjectionRow[]>>;
  sampleCap: number;
};

const ALL_CAUSES: CauseKey[] = [
  "won",
  "opted_out",
  "dm_said_no",
  "callback_booked",
  "mid_follow_up",
  "gatekeeper",
  "bad_number",
  "no_contact",
];

/** Cause of death: for every lead with >=1 call in the dashboard window, the
 *  single primary reason it is not won.
 *
 *  One aggregate. This used to page every call in the window, chunk-load all
 *  ~7,500 of those leads, classify each in JavaScript, and then send every
 *  company name to the browser — ~5,000ms and 1,271 KB, twelve times the
 *  dashboard's payload, for lists that render inside collapsed <details>
 *  (20260907100000).
 *
 *  assignCause() still exists and is still the specification; the SQL is
 *  transcribed from it branch for branch, and
 *  `npm run verify:cause-of-death` runs the REAL classifier against the RPC
 *  over six production windows. */
export async function fetchCauseOfDeath(
  supabase: DB,
  scope: DashboardKpiScope,
): Promise<CauseSummary> {
  const campaignIds =
    scope.campaignIds && scope.campaignIds.length > 0
      ? scope.campaignIds
      : null;
  const empty: CauseSummary = {
    total: 0,
    counts: Object.fromEntries(ALL_CAUSES.map((c) => [c, 0])) as Record<
      CauseKey,
      number
    >,
    groups: { won: 0, final: 0, in_play: 0 },
    samples: {},
    noContact: [],
    objectionsByCause: {},
    sampleCap: CAUSE_SAMPLE_CAP,
  };
  if (!scope.all && !campaignIds) return empty;

  const { data, error } = await supabase.rpc("cause_of_death_summary", {
    p_since: sinceDaysAgoIso(DASHBOARD_DAYS),
    ...(scope.all || !campaignIds ? {} : { p_campaign_ids: campaignIds }),
    p_sample: CAUSE_SAMPLE_CAP,
  });
  // Fail loud rather than rendering a confident, fully-drawn breakdown of zero.
  if (error) {
    throw new Error(`Cause of death failed: ${error.message}`);
  }

  const raw = (data ?? {}) as {
    total?: number;
    causes?: Record<string, { count: number; sample: string[] }>;
    noContact?: Record<string, { count: number; sample: string[] }>;
    objections?: Record<string, ObjectionRow[]>;
  };
  if (!raw.total) return empty;

  const counts = Object.fromEntries(
    ALL_CAUSES.map((c) => [c, raw.causes?.[c]?.count ?? 0]),
  ) as Record<CauseKey, number>;

  // Group totals are derived from the counts, exactly as computeCauseOfDeath
  // did — one definition of which cause belongs to which group (CAUSE_GROUP).
  const groups: Record<CauseGroup, number> = { won: 0, final: 0, in_play: 0 };
  for (const c of ALL_CAUSES) groups[CAUSE_GROUP[c]] += counts[c];

  const samples: Partial<Record<CauseKey, CauseSampleList>> = {};
  for (const c of ALL_CAUSES) {
    const hit = raw.causes?.[c];
    if (hit) samples[c] = { count: hit.count, sample: hit.sample ?? [] };
  }

  // Precedence order, matching noContactReason(): a person > a machine >
  // nobody picked up > an error.
  const noContact = (Object.keys(NO_CONTACT_LABEL) as NoContactReason[])
    .filter((r) => (raw.noContact?.[r]?.count ?? 0) > 0)
    .map((r) => ({
      reason: r,
      list: {
        count: raw.noContact![r]!.count,
        sample: raw.noContact![r]!.sample ?? [],
      },
    }));

  return {
    total: raw.total,
    counts,
    groups,
    samples,
    noContact,
    objectionsByCause: (raw.objections ?? {}) as Partial<
      Record<CauseKey, ObjectionRow[]>
    >,
    sampleCap: CAUSE_SAMPLE_CAP,
  };
}

export async function fetchChangelogRows(
  supabase: DB,
): Promise<ChangelogRow[]> {
  // Paged: PostgREST clamps every response to 1,000 rows, so the old
  // `.limit(2000)` silently dropped the oldest entries past that. The `id`
  // tiebreaker keeps the page order deterministic.
  const data = await fetchAllRows((from, to) =>
    supabase
      .from("app_changelog")
      .select(
        "id, change_date, area, change_type, summary, details, status, ticket_link",
      )
      .order("change_date", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to),
  );

  return data.map((r) => ({
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

  // Paged past PostgREST's 1,000-row cap (see fetchChangelogRows); the diff
  // baseline below walks the WHOLE history, so a truncated list would silently
  // diff against the wrong prompt.
  const data = await fetchAllRows((from, to) => {
    let q = supabase
      .from("agent_prompt_log")
      .select(
        "id, log_date, version, changed, what_changed, why, full_prompt, agent_id, agent:agents(name)",
      )
      .order("log_date", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    if (agentId) q = q.eq("agent_id", agentId);
    return q.range(from, to);
  });

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
  const raw = data as unknown as Raw[];
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
