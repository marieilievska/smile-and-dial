import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { defsForAnalysis, loadActiveFlagDefs } from "./rubric";
import { analyzeCall } from "./analyze";
import { resolveAgentPlaybook, type PlaybookStep } from "./playbook";
import { ensureStandardRubric } from "./rubric-seed";
import { loadRejectedExamples } from "./rejected";
import type { RejectedExample } from "./prompts";
import { PASS1_MODEL, PASS2_MODEL } from "./openai";

type Admin = ReturnType<typeof createClient<Database>>;

function admin(): Admin {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export type ReviewTickSummary = {
  claimed: number;
  analyzed: number;
  errors: number;
};

/** Turn a stored transcript_json into a plain "Speaker: text" string. */
function transcriptToText(raw: unknown): string {
  const turns = Array.isArray(raw)
    ? raw
    : raw &&
        typeof raw === "object" &&
        Array.isArray((raw as { transcript?: unknown }).transcript)
      ? (raw as { transcript: unknown[] }).transcript
      : [];
  return (turns as Record<string, unknown>[])
    .map((t) => {
      const role = t.role === "user" ? "Lead" : "Agent";
      const msg =
        typeof t.message === "string"
          ? t.message
          : typeof t.text === "string"
            ? t.text
            : "";
      return msg ? `${role}: ${msg}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** One review tick: claim pending reviews, analyze, store flags. Idempotent. */
export async function runReviewTick(
  opts: { limit?: number } = {},
): Promise<ReviewTickSummary> {
  const db = admin();
  const summary: ReviewTickSummary = { claimed: 0, analyzed: 0, errors: 0 };

  const { data: pending } = await db
    .from("call_reviews")
    .select("call_id")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(opts.limit ?? 25);
  if (!pending || pending.length === 0) return summary;

  // Self-heal the rubric before loading it: if a data reset wiped
  // review_flag_defs while these rows were queued, analyzing against an empty
  // rubric would store zero flags. Cheap no-op when the rubric is present.
  await ensureStandardRubric(db);
  const defs = defsForAnalysis(await loadActiveFlagDefs(db));

  // Resolve each agent's checklist and past false alarms once per tick (many
  // calls share an agent, and the checklist costs an ElevenLabs fetch).
  type AgentContext = { steps: PlaybookStep[]; rejected: RejectedExample[] };
  const contextCache = new Map<string, AgentContext>();
  let derivationCost = 0;
  async function contextFor(agentId: string | null): Promise<AgentContext> {
    const keyId = agentId ?? "";
    const hit = contextCache.get(keyId);
    if (hit) return hit;
    const [{ playbook, cost }, rejected] = await Promise.all([
      resolveAgentPlaybook(db, agentId),
      loadRejectedExamples(db, agentId),
    ]);
    derivationCost += cost;
    const ctx: AgentContext = { steps: playbook?.steps ?? [], rejected };
    contextCache.set(keyId, ctx);
    return ctx;
  }

  for (const row of pending) {
    const { data: claimed } = await db
      .from("call_reviews")
      .update({ status: "analyzing" })
      .eq("call_id", row.call_id)
      .eq("status", "pending")
      .select("call_id");
    if (!claimed || claimed.length === 0) continue;
    summary.claimed++;

    try {
      const { data: call } = await db
        .from("calls")
        .select("agent_id, transcript_json, extracted_data, cost_breakdown")
        .eq("id", row.call_id)
        .maybeSingle();
      const transcript = transcriptToText(call?.transcript_json);
      if (!transcript.trim()) {
        await db
          .from("call_reviews")
          .update({ status: "done", analyzed_at: new Date().toISOString() })
          .eq("call_id", row.call_id);
        continue;
      }
      const ctx = await contextFor(call?.agent_id ?? null);
      const { findings, cost: analyzeCost } = await analyzeCall({
        transcript,
        extracted: JSON.stringify(call?.extracted_data ?? {}),
        defs,
        steps: ctx.steps,
        rejected: ctx.rejected,
      });
      // Charge this call for its own analysis plus any checklist derivation
      // triggered on its behalf; the derivation is banked so the next call in
      // the tick isn't billed again for the same agent.
      const cost = analyzeCost + derivationCost;
      derivationCost = 0;
      const stepTitle = new Map(ctx.steps.map((s) => [s.key, s.title]));
      // Human decisions are sticky: a re-queued analysis must never overwrite
      // a flag a human already curated ("Looks right" / "False alarm") — else a
      // re-review could resurrect a rejected finding, undoing the correction
      // that teaches the reviewer not to make it again. Skip curated rows.
      const { data: curatedRows } = await db
        .from("call_review_flags")
        .select("flag_key, step_key")
        .eq("call_id", row.call_id)
        .not("curated_at", "is", null);
      // Curation is per finding, and a playbook finding is identified by its
      // step — so rejecting one missed step must not protect the others.
      const curatedKeys = new Set(
        (curatedRows ?? []).map((r) => `${r.flag_key}:${r.step_key ?? ""}`),
      );
      const isCurated = (f: { flag_key: string; step_key: string | null }) =>
        curatedKeys.has(`${f.flag_key}:${f.step_key ?? ""}`);
      for (const f of findings) {
        if (isCurated(f)) continue;
        await db.from("call_review_flags").upsert(
          {
            call_id: row.call_id,
            flag_key: f.flag_key,
            step_key: f.step_key ?? "",
            step_title: f.step_key ? (stepTitle.get(f.step_key) ?? null) : null,
            evidence_quote: f.evidence_quote,
            confidence: f.confidence,
            status: f.status,
          },
          { onConflict: "call_id,flag_key,step_key" },
        );
      }
      await db
        .from("call_reviews")
        .update({
          status: "done",
          needs_review: findings.some(
            (f) => !isCurated(f) && f.status === "needs_review",
          ),
          pass1_model: PASS1_MODEL,
          pass2_model: PASS2_MODEL,
          cost,
          analyzed_at: new Date().toISOString(),
        })
        .eq("call_id", row.call_id);

      // Record the reviewer's OpenAI spend on the CALL itself so the Costs page
      // counts it. It lives in its own `openai_review` sub-field (kept apart
      // from the call-time `openai`) and is SET, not added, so a re-queued
      // re-review never double-counts. total is recomputed from the itemized
      // components (mirrors pickBreakdown in lib/analytics/costs.ts).
      if (cost > 0) {
        const cb = (call?.cost_breakdown ?? {}) as Record<string, number>;
        const nextCost = {
          ...cb,
          openai_review: cost,
          total:
            (Number(cb.twilio) || 0) +
            (Number(cb.elevenlabs) || 0) +
            (Number(cb.openai) || 0) +
            (Number(cb.lookup) || 0) +
            cost,
        };
        await db
          .from("calls")
          .update({
            cost_breakdown:
              nextCost as unknown as Database["public"]["Tables"]["calls"]["Update"]["cost_breakdown"],
          })
          .eq("id", row.call_id);
      }
      summary.analyzed++;
    } catch (e) {
      summary.errors++;
      await db
        .from("call_reviews")
        .update({
          status: "error",
          error: e instanceof Error ? e.message : "unknown",
        })
        .eq("call_id", row.call_id);
    }
  }
  return summary;
}
