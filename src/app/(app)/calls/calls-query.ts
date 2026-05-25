import type { createClient } from "@/lib/supabase/server";

import type { SearchParams } from "./calls-url";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * The select string shared by every Calls page read. Single literal so
 * Supabase can infer the row type. Pulls the joined lead / campaign / agent
 * names in one round trip.
 */
export const CALLS_SELECT =
  "id, direction, status, outcome, goal_met, started_at, answered_at, ended_at, duration_seconds, talk_time_seconds, recording_path, score, cost_breakdown, created_at, lead:leads(id, company, business_phone, owner_id), campaign:campaigns(id, name), agent:agents(id, name)";

/** Columns the table allows sorting by. */
export const SORT_KEYS = new Set<string>([
  "created_at",
  "started_at",
  "duration_seconds",
  "talk_time_seconds",
  "outcome",
  "status",
]);

/** Read a single string value from Next.js search params. */
export function str(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

/** Resolve the sort column and direction from search params. */
export function parseSort(params: SearchParams): {
  sort: string;
  dir: "asc" | "desc";
} {
  const sort = SORT_KEYS.has(str(params.sort))
    ? str(params.sort)
    : "started_at";
  const dir: "asc" | "desc" = params.dir === "asc" ? "asc" : "desc";
  return { sort, dir };
}

/**
 * Build a Supabase calls query with the page's filters applied. Search is
 * handled separately by `resolveSearchLeadIds` because PostgREST can't
 * filter the parent rows on a `to-one` embed without an `!inner` join, and
 * we don't want to complicate the select string for one feature.
 */
export function buildCallsQuery(
  supabase: SupabaseServerClient,
  params: SearchParams,
  searchLeadIds?: string[],
) {
  let query = supabase.from("calls").select(CALLS_SELECT, { count: "exact" });

  if (searchLeadIds !== undefined) {
    // Empty array → no calls match. PostgREST's `.in("col", [])` is buggy
    // (matches everything), so guard with a sentinel uuid.
    query = query.in(
      "lead_id",
      searchLeadIds.length > 0
        ? searchLeadIds
        : ["00000000-0000-0000-0000-000000000000"],
    );
  }

  const direction = str(params.direction);
  if (direction === "inbound" || direction === "outbound") {
    query = query.eq("direction", direction);
  }

  const status = str(params.status);
  const VALID_STATUSES = new Set([
    "queued",
    "dialing",
    "ringing",
    "in_progress",
    "completed",
    "failed",
    "cancelled",
  ]);
  if (VALID_STATUSES.has(status)) query = query.eq("status", status);

  const outcome = str(params.outcome);
  if (outcome) query = query.eq("outcome", outcome);

  const campaignId = str(params.campaign);
  if (UUID_RE.test(campaignId)) query = query.eq("campaign_id", campaignId);

  const dateFilters: [string, string, string][] = [
    ["from", "to", "started_at"],
  ];
  for (const [fromKey, toKey, column] of dateFilters) {
    const from = str(params[fromKey]);
    const to = str(params[toKey]);
    if (DATE_RE.test(from)) query = query.gte(column, from);
    if (DATE_RE.test(to)) query = query.lte(column, `${to}T23:59:59`);
  }

  return query;
}

/**
 * Resolve the `q=` search to a list of matching lead IDs. Returns `null`
 * when no search was specified (so the caller doesn't add a filter at all).
 */
export async function resolveSearchLeadIds(
  supabase: SupabaseServerClient,
  params: SearchParams,
): Promise<string[] | null> {
  const search = str(params.q)
    .replace(/[%,()\\*]/g, "")
    .trim();
  if (!search) return null;
  const { data } = await supabase
    .from("leads")
    .select("id")
    .or(
      `company.ilike.%${search}%,business_phone.ilike.%${search}%,business_email.ilike.%${search}%`,
    )
    .limit(5000);
  return (data ?? []).map((l) => l.id);
}
