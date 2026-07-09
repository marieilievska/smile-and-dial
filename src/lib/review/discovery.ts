import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { callOpenAiJson, PASS2_MODEL } from "./openai";

type Admin = ReturnType<typeof createClient<Database>>;

const LENSES = ["bug", "compliance", "quality", "opportunity", "voc"] as const;
type Lens = (typeof LENSES)[number];

/** One sampled call fed to the discovery model (summary only — cheap, and
 *  enough to spot recurring themes; full transcripts would blow the budget). */
export type DiscoverySample = { callId: string; summary: string };

/** A raw proposal from the model, before validation/dedup. */
export type ProposedCandidate = {
  key: string;
  label: string;
  lens: Lens;
  severity: number;
  guidance: string;
  rationale: string;
  exampleCallIds: string[];
};

export type DiscoveryPassSummary = {
  sampled: number;
  proposed: number;
  inserted: number;
  live: boolean;
  cost: number;
};

/** JSON schema forcing structured proposals. Kept small; the model may return
 *  an empty array when the rubric already covers everything. */
export const DISCOVERY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "key",
          "label",
          "lens",
          "severity",
          "guidance",
          "rationale",
          "example_call_ids",
        ],
        properties: {
          key: { type: "string" },
          label: { type: "string" },
          lens: { type: "string", enum: [...LENSES] },
          severity: { type: "integer" },
          guidance: { type: "string" },
          rationale: { type: "string" },
          example_call_ids: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

/** Build the discovery user-prompt. Pure. Tells the model which keys/labels are
 *  already covered or previously rejected so it only proposes genuinely-new,
 *  recurring patterns. */
export function buildDiscoveryPrompt(input: {
  samples: DiscoverySample[];
  activeKeys: string[];
  candidateKeys: string[];
  dismissedLabels: string[];
}): string {
  const off = [...input.activeKeys, ...input.candidateKeys];
  const lines: string[] = [];
  lines.push(
    "You are reviewing recent sales/booking phone calls that our fixed flag rubric did NOT flag.",
    "Propose NEW recurring situations worth flagging that the existing flags miss.",
    "Only propose a pattern you can see recurring across MULTIPLE calls below. Return an empty list if nothing recurs.",
    "",
    `Existing flag keys (do NOT re-propose these): ${off.length ? off.join(", ") : "(none)"}`,
    `Previously rejected ideas (do NOT re-propose): ${input.dismissedLabels.length ? input.dismissedLabels.join("; ") : "(none)"}`,
    "",
    "For each new flag give: a snake_case key, a short label, a lens (bug|compliance|quality|opportunity|voc), a severity 1 (high) to 4 (info), one-sentence analyzer guidance, a one-sentence rationale, and the example_call_ids it appears in.",
    "",
    "Calls (id: summary):",
  );
  for (const s of input.samples) lines.push(`- ${s.callId}: ${s.summary}`);
  return lines.join("\n");
}

/** Validate + de-dupe raw proposals. Pure. Drops anything whose key already
 *  exists (active or pending candidate) or was dismissed, has a bad lens/
 *  severity, or repeats within the batch. */
export function dedupeProposals(
  proposals: ProposedCandidate[],
  existingKeys: Set<string>,
  dismissedKeys: Set<string>,
): ProposedCandidate[] {
  const seen = new Set<string>();
  const out: ProposedCandidate[] = [];
  for (const p of proposals) {
    const key = (p.key || "").trim();
    if (!key) continue;
    if (existingKeys.has(key) || dismissedKeys.has(key) || seen.has(key))
      continue;
    if (!LENSES.includes(p.lens)) continue;
    if (!Number.isInteger(p.severity) || p.severity < 1 || p.severity > 4)
      continue;
    // A blank label/guidance would insert a silently-degraded rubric row (the
    // guidance IS the Pass-1 prompt text for that flag), so drop it.
    if (!(p.label || "").trim() || !(p.guidance || "").trim()) continue;
    seen.add(key);
    out.push({ ...p, key });
  }
  return out;
}

/** Sample recent human-reached calls that carry NO confirmed flags (the
 *  rubric's blind spots), returning their summaries. Fetch the recent
 *  done+reached_human reviews first, then look up confirmed flags scoped to
 *  EXACTLY those call ids — an exact diff, avoiding a NOT-IN subquery PostgREST
 *  can't express cleanly. (Ordering call_review_flags by its own PK would be
 *  meaningless: `id` is a random uuid, so a blanket "recent flags" fetch is not
 *  actually recent and could mislabel a flagged call as a blind spot.) */
export async function sampleUnflaggedCalls(
  admin: Admin,
  limit = 40,
): Promise<DiscoverySample[]> {
  const { data: reviews } = await admin
    .from("call_reviews")
    .select("call_id")
    .eq("status", "done")
    .eq("reached_human", true)
    .order("analyzed_at", { ascending: false })
    .limit(600);
  const reviewIds = (reviews ?? []).map((r) => r.call_id);
  if (reviewIds.length === 0) return [];

  // Confirmed flags for exactly this review pool — an exact, bounded diff.
  const { data: flagged } = await admin
    .from("call_review_flags")
    .select("call_id")
    .eq("status", "confirmed")
    .in("call_id", reviewIds);
  const flaggedSet = new Set((flagged ?? []).map((f) => f.call_id));

  const candidateIds = reviewIds
    .filter((id) => !flaggedSet.has(id))
    .slice(0, limit);
  if (candidateIds.length === 0) return [];

  const { data: calls } = await admin
    .from("calls")
    .select("id, summary")
    .in("id", candidateIds);
  return (calls ?? [])
    .map((c) => ({ callId: c.id, summary: (c.summary ?? "").trim() }))
    .filter((s) => s.summary.length > 0);
}

/** Run one discovery pass: sample → propose (Pass-2 model) → validate/dedup →
 *  insert candidates. Idempotent-ish: duplicate keys are dropped by dedup and by
 *  the unique(key) constraint (ignoreDuplicates on insert). */
export async function runDiscoveryPass(
  admin: Admin,
  opts: { sampleLimit?: number } = {},
): Promise<DiscoveryPassSummary> {
  const samples = await sampleUnflaggedCalls(admin, opts.sampleLimit ?? 40);
  if (samples.length === 0)
    return { sampled: 0, proposed: 0, inserted: 0, live: false, cost: 0 };

  const { data: defs } = await admin
    .from("review_flag_defs")
    .select("key, label, active, is_candidate, dismissed_at");
  const activeKeys = (defs ?? []).filter((d) => d.active).map((d) => d.key);
  const candidateKeys = (defs ?? [])
    .filter((d) => d.is_candidate && !d.dismissed_at)
    .map((d) => d.key);
  const dismissed = (defs ?? []).filter((d) => d.dismissed_at);
  const existingKeys = new Set((defs ?? []).map((d) => d.key));
  const dismissedKeys = new Set(dismissed.map((d) => d.key));

  const prompt = buildDiscoveryPrompt({
    samples,
    activeKeys,
    candidateKeys,
    dismissedLabels: dismissed.map((d) => d.label),
  });

  const { data, cost, live } = await callOpenAiJson<{ candidates: unknown[] }>({
    model: PASS2_MODEL,
    system:
      "You find recurring, flaggable situations in call summaries that an existing rubric misses. Be conservative: propose only clear, recurring patterns. Output must match the schema.",
    user: prompt,
    schema: DISCOVERY_SCHEMA,
    schemaName: "discovery",
    mock: { candidates: [] },
  });

  const raw = (data?.candidates ?? []) as Record<string, unknown>[];
  const proposals: ProposedCandidate[] = raw.map((c) => ({
    key: String(c.key ?? ""),
    label: String(c.label ?? ""),
    lens: c.lens as Lens,
    severity: Number(c.severity ?? 0),
    guidance: String(c.guidance ?? ""),
    rationale: String(c.rationale ?? ""),
    exampleCallIds: Array.isArray(c.example_call_ids)
      ? (c.example_call_ids as unknown[]).map(String)
      : [],
  }));
  const fresh = dedupeProposals(proposals, existingKeys, dismissedKeys);

  let inserted = 0;
  if (fresh.length > 0) {
    // Only keep example ids that were actually in this sample (guards against
    // the model inventing uuids that would violate nothing but mislead the UI).
    const sampleIds = new Set(samples.map((s) => s.callId));
    const rows = fresh.map((p) => ({
      key: p.key,
      label: p.label,
      lens: p.lens,
      severity: p.severity,
      guidance: p.guidance,
      rationale: p.rationale,
      example_call_ids: p.exampleCallIds.filter((id) => sampleIds.has(id)),
      active: false,
      is_candidate: true,
      proposed_at: new Date().toISOString(),
    }));
    const { data: ins } = await admin
      .from("review_flag_defs")
      .upsert(rows, { onConflict: "key", ignoreDuplicates: true })
      .select("key");
    inserted = ins?.length ?? 0;
  }

  return {
    sampled: samples.length,
    proposed: proposals.length,
    inserted,
    live,
    cost,
  };
}
