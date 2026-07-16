import "server-only";

import type { createClient as createServerClient } from "@/lib/supabase/server";

import { chunk } from "./chunk";
import type { PromptEdit } from "./types";

type ServerClient = Awaited<ReturnType<typeof createServerClient>>;

export type SuggestOption = {
  agentId: string;
  agentName: string;
  available: number;
};

/** flag_key -> agents with available (human-approved, unconsumed) examples. */
export type SuggestOptionsByBucket = Record<string, SuggestOption[]>;

/** Powers the per-bucket "Suggest prompt fix" button. Pages call_review_flags
 *  (PostgREST 1000-row cap), resolves call→agent in chunks, tallies in JS —
 *  same pattern as fetchChecklistFlags. */
export async function fetchSuggestOptions(
  client: ServerClient,
): Promise<SuggestOptionsByBucket> {
  const flags: { flag_key: string; call_id: string }[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from("call_review_flags")
      .select("flag_key, call_id")
      .eq("status", "confirmed")
      .not("curated_at", "is", null)
      .is("suggestion_id", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) break;
    const page = data ?? [];
    for (const r of page) {
      if (r.call_id) flags.push({ flag_key: r.flag_key, call_id: r.call_id });
    }
    if (page.length < PAGE) break;
  }
  if (flags.length === 0) return {};

  const agentByCall = new Map<string, string>();
  for (const ids of chunk([...new Set(flags.map((f) => f.call_id))])) {
    const { data } = await client
      .from("calls")
      .select("id, agent_id")
      .in("id", ids);
    for (const c of data ?? [])
      if (c.agent_id) agentByCall.set(c.id, c.agent_id);
  }

  const counts = new Map<string, Map<string, number>>();
  for (const f of flags) {
    const agentId = agentByCall.get(f.call_id);
    if (!agentId) continue;
    const perAgent = counts.get(f.flag_key) ?? new Map<string, number>();
    perAgent.set(agentId, (perAgent.get(agentId) ?? 0) + 1);
    counts.set(f.flag_key, perAgent);
  }

  const agentIds = [
    ...new Set([...counts.values()].flatMap((m) => [...m.keys()])),
  ];
  const nameById = new Map<string, string>();
  if (agentIds.length > 0) {
    const { data } = await client
      .from("agents")
      .select("id, name")
      .in("id", agentIds);
    for (const a of data ?? []) nameById.set(a.id, a.name);
  }

  const out: SuggestOptionsByBucket = {};
  for (const [key, perAgent] of counts) {
    out[key] = [...perAgent.entries()]
      .map(([agentId, available]) => ({
        agentId,
        agentName: nameById.get(agentId) ?? "Unknown agent",
        available,
      }))
      .sort((a, b) => b.available - a.available);
  }
  return out;
}

export type PromptSuggestionView = {
  id: string;
  agentName: string;
  bucketLabel: string;
  status: "proposed" | "applied" | "dismissed" | "reverted";
  rationale: string;
  summary: string;
  edits: PromptEdit[];
  exampleCount: number;
  /** Contributing calls (present while the suggestion holds its examples). */
  callIds: string[];
  createdAt: string;
  appliedAt: string | null;
};

const SUGGESTION_LIST_CAP = 30;

/** The "Prompt improvements" panel list: awaiting-review first, then the most
 *  recently decided. Names/labels/contributing calls joined in JS. */
export async function fetchPromptSuggestions(
  client: ServerClient,
): Promise<PromptSuggestionView[]> {
  const { data: rows } = await client
    .from("review_prompt_suggestions")
    .select(
      "id, agent_id, flag_key, status, rationale, summary, edits, example_count, created_at, applied_at",
    )
    .order("created_at", { ascending: false })
    .limit(SUGGESTION_LIST_CAP);
  const list = rows ?? [];
  if (list.length === 0) return [];

  const agentIds = [...new Set(list.map((r) => r.agent_id))];
  const keys = [...new Set(list.map((r) => r.flag_key))];
  const [{ data: agents }, { data: defs }, { data: flagRows }] =
    await Promise.all([
      client.from("agents").select("id, name").in("id", agentIds),
      client.from("review_flag_defs").select("key, label").in("key", keys),
      client
        .from("call_review_flags")
        .select("call_id, suggestion_id")
        .in(
          "suggestion_id",
          list.map((r) => r.id),
        ),
    ]);
  const nameById = new Map((agents ?? []).map((a) => [a.id, a.name]));
  const labelByKey = new Map((defs ?? []).map((d) => [d.key, d.label]));
  const callsBySuggestion = new Map<string, string[]>();
  for (const f of flagRows ?? []) {
    if (!f.suggestion_id || !f.call_id) continue;
    const arr = callsBySuggestion.get(f.suggestion_id) ?? [];
    arr.push(f.call_id);
    callsBySuggestion.set(f.suggestion_id, arr);
  }

  const shaped: PromptSuggestionView[] = list.map((r) => ({
    id: r.id,
    agentName: nameById.get(r.agent_id) ?? "Unknown agent",
    bucketLabel: labelByKey.get(r.flag_key) ?? r.flag_key,
    status: r.status as PromptSuggestionView["status"],
    rationale: r.rationale,
    summary: r.summary,
    edits: r.edits as unknown as PromptEdit[],
    exampleCount: r.example_count,
    callIds: callsBySuggestion.get(r.id) ?? [],
    createdAt: r.created_at,
    appliedAt: r.applied_at,
  }));
  return [
    ...shaped.filter((s) => s.status === "proposed"),
    ...shaped.filter((s) => s.status !== "proposed"),
  ];
}
