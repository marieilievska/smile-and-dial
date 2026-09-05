import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";

/**
 * `ai_charges` — the ledger for AI spend that has no call to hang off (or
 * that a call's `cost_breakdown` alone would hide): the Ask Smile assistant,
 * agent drafting / template splitting / script tidying, the demo_front_desk
 * live research (ALSO added to the call's `cost_breakdown.openai`), and
 * ElevenLabs Test Calls (browser sessions the post-call webhook cannot match
 * to a call row). The Costs page folds the ledger into the OpenAI vendor line
 * and the headline total, and lists it by kind under "Other AI usage".
 *
 * Every recorder is BEST-EFFORT: a failed insert is logged and swallowed. A
 * cost ledger must never break the feature it is metering.
 */

export const AI_CHARGE_KINDS = [
  "ask_smile",
  "draft_agent",
  "split_agent_template",
  "tidy_prose",
  "business_research",
  "elevenlabs_test_call",
] as const;

export type AiChargeKind = (typeof AI_CHARGE_KINDS)[number];

/** Human labels for the Costs page. Unknown kinds fall back to the raw key. */
export const AI_CHARGE_KIND_LABELS: Record<AiChargeKind, string> = {
  ask_smile: "Ask Smile answers",
  draft_agent: "Agent drafting",
  split_agent_template: "Template splitting",
  tidy_prose: "Script tidy-ups",
  business_research: "Live business research (demo)",
  elevenlabs_test_call: "ElevenLabs test calls",
};

export function aiChargeKindLabel(kind: string): string {
  return (AI_CHARGE_KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

export type AiChargeInput = {
  ownerId: string;
  kind: AiChargeKind;
  model: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cost: number;
  refTable?: string | null;
  refId?: string | null;
  detail?: Record<string, Json | undefined>;
};

type Writer = Pick<SupabaseClient<Database>, "from">;

/** Insert one ledger row with a service-role client. Never throws. */
export async function recordAiCharge(
  admin: Writer,
  input: AiChargeInput,
): Promise<void> {
  if (!input.ownerId) return;
  const cost = Number.isFinite(input.cost) ? Math.max(0, input.cost) : 0;
  try {
    const { error } = await admin.from("ai_charges").insert({
      owner_id: input.ownerId,
      kind: input.kind,
      model: input.model,
      input_tokens: Math.max(0, Math.round(input.inputTokens ?? 0)),
      output_tokens: Math.max(0, Math.round(input.outputTokens ?? 0)),
      cost: Number(cost.toFixed(4)),
      ref_table: input.refTable ?? null,
      ref_id: input.refId ?? null,
      detail: (input.detail ?? {}) as Json,
    });
    if (error) console.error("[ai-charges] insert failed", error.message);
  } catch (err) {
    console.error("[ai-charges] insert threw", err);
  }
}

/** Same, for callers that only hold a user-scoped client (server actions):
 *  builds a service-role client from env. Silently a no-op when the service
 *  key is not configured (local dev without one). */
export async function recordAiChargeAsService(
  input: AiChargeInput,
): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) return;
  const admin = createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await recordAiCharge(admin, input);
}

export type TokenUsage = { inputTokens: number; outputTokens: number };

function nonNeg(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Token usage from a Chat Completions body (`usage.prompt_tokens` /
 *  `usage.completion_tokens`). Zeros when absent. */
export function chatCompletionUsage(body: unknown): TokenUsage {
  const usage = ((body ?? {}) as { usage?: Record<string, unknown> }).usage;
  return {
    inputTokens: nonNeg(usage?.prompt_tokens),
    outputTokens: nonNeg(usage?.completion_tokens),
  };
}

/** Token usage + web-search call count from a Responses API body
 *  (`usage.input_tokens` / `usage.output_tokens`; `output[]` items of type
 *  `web_search_call`). Zeros when absent. */
export function responsesUsage(
  body: unknown,
): TokenUsage & { webSearchCalls: number } {
  const b = (body ?? {}) as {
    usage?: Record<string, unknown>;
    output?: unknown;
  };
  let webSearchCalls = 0;
  if (Array.isArray(b.output)) {
    for (const item of b.output) {
      if (
        item &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "web_search_call"
      ) {
        webSearchCalls += 1;
      }
    }
  }
  return {
    inputTokens: nonNeg(b.usage?.input_tokens),
    outputTokens: nonNeg(b.usage?.output_tokens),
    webSearchCalls,
  };
}
