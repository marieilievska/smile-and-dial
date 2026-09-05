/**
 * The one definition of what a call's `cost_breakdown` JSON means.
 *
 * Pure module — no server imports — so it is safe from Server Components,
 * route handlers, the analytics layer AND client components (the Calls list
 * and call modal render the same total the Costs page sums).
 *
 * Shape of `calls.cost_breakdown` (all USD unless noted):
 *   twilio                 vendor component: call minutes + media-stream minutes
 *   twilio_call            sub-part of `twilio` (informational, NOT summed)
 *   twilio_media_stream    sub-part of `twilio` (informational, NOT summed)
 *   elevenlabs             vendor component: credits × $/credit
 *   elevenlabs_llm         sub-part of `elevenlabs` (NOT summed)
 *   elevenlabs_voice       sub-part of `elevenlabs` (NOT summed)
 *   elevenlabs_*_credits   raw credits (NOT summed)
 *   openai                 vendor component: call-time OpenAI work
 *   openai_review          vendor component: the async Call Reviewer
 *   lookup                 vendor component: Twilio Lookup
 *   total                  = twilio + elevenlabs + openai + openai_review + lookup
 *
 * The SQL twin of this file is `public.call_cost_total(jsonb)` (migration
 * 20260905181000); `refresh_cost_rollup` and `monitor_campaign_spend_caps`
 * both use it, so every surface agrees on what a call cost.
 */

/** The keys that add up to `total`. Everything else in the JSON is either a
 *  sub-part of one of these or raw credits, and is deliberately NOT summed. */
export const COST_COMPONENT_KEYS = [
  "twilio",
  "elevenlabs",
  "openai",
  "openai_review",
  "lookup",
] as const;

export type Breakdown = {
  twilio: number;
  elevenlabs: number;
  // ElevenLabs LLM vs voice/telephony split (USD) — sub-components of
  // `elevenlabs`, NOT counted again in `total`. Plus the raw credits for each.
  elevenlabsLlm: number;
  elevenlabsVoice: number;
  elevenlabsCredits: number;
  elevenlabsLlmCredits: number;
  elevenlabsVoiceCredits: number;
  openai: number;
  lookup: number;
  total: number;
};

const ZERO: Breakdown = {
  twilio: 0,
  elevenlabs: 0,
  elevenlabsLlm: 0,
  elevenlabsVoice: 0,
  elevenlabsCredits: 0,
  elevenlabsLlmCredits: 0,
  elevenlabsVoiceCredits: 0,
  openai: 0,
  lookup: 0,
  total: 0,
};

/** A fresh all-zero Breakdown (never share the constant — callers mutate). */
export function zeroBreakdown(): Breakdown {
  return { ...ZERO };
}

/** Numeric JSON field or 0 — the TS twin of `public.j_num`. */
export function numField(value: unknown, key: string): number {
  if (!value || typeof value !== "object") return 0;
  const v = (value as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function round4(n: number): number {
  return Number(n.toFixed(4));
}

/** Sum of the itemized vendor components (see COST_COMPONENT_KEYS). */
export function componentSum(value: unknown): number {
  let sum = 0;
  for (const k of COST_COMPONENT_KEYS) sum += numField(value, k);
  return sum;
}

/**
 * The call's cost: the component sum when the row is itemized, else the
 * stored `total` (legacy rows that carry a total with no itemization — never
 * drop a real-but-unitemized cost). Mirrors `public.call_cost_total`.
 */
export function breakdownTotal(value: unknown): number {
  const sum = componentSum(value);
  return sum > 0 ? sum : numField(value, "total");
}

/**
 * Return `breakdown` with `total` recomputed from its components. EVERY writer
 * of `cost_breakdown` must pass its object through this before saving — the
 * stored total is what the Calls list, the call modal, `pre_call_check` and
 * the spend-cap monitor read, and a writer that bumps one component without
 * recomputing leaves it stale (1,183 of 7,888 calls were, before this helper).
 *
 * Other keys are preserved untouched. Only the object is read; the input is
 * not mutated.
 */
export function withRecomputedTotal<T extends Record<string, unknown>>(
  breakdown: T,
): T & { total: number } {
  return { ...breakdown, total: round4(breakdownTotal(breakdown)) };
}

/** Parse a stored `cost_breakdown` into the itemized view every aggregate
 *  uses. `openai` folds in `openai_review`; `total` is derived (see
 *  breakdownTotal), never trusted from the row. */
export function pickBreakdown(value: unknown): Breakdown {
  if (!value || typeof value !== "object") return { ...ZERO };
  const n = (k: string) => numField(value, k);
  return {
    twilio: n("twilio"),
    elevenlabs: n("elevenlabs"),
    elevenlabsLlm: n("elevenlabs_llm"),
    elevenlabsVoice: n("elevenlabs_voice"),
    elevenlabsCredits: n("elevenlabs_credits"),
    elevenlabsLlmCredits: n("elevenlabs_llm_credits"),
    elevenlabsVoiceCredits: n("elevenlabs_voice_credits"),
    // The "OpenAI" line is the sum of two sources: call-time work (summaries,
    // transcription, live research — under `openai`) and the async Call
    // Reviewer (under `openai_review`). Both roll into one OpenAI figure.
    openai: n("openai") + n("openai_review"),
    lookup: n("lookup"),
    total: breakdownTotal(value),
  };
}

/** Add `b` into `acc` in place (every field, including the sub-parts). */
export function addBreakdownInto(acc: Breakdown, b: Breakdown): void {
  acc.twilio += b.twilio;
  acc.elevenlabs += b.elevenlabs;
  acc.elevenlabsLlm += b.elevenlabsLlm;
  acc.elevenlabsVoice += b.elevenlabsVoice;
  acc.elevenlabsCredits += b.elevenlabsCredits;
  acc.elevenlabsLlmCredits += b.elevenlabsLlmCredits;
  acc.elevenlabsVoiceCredits += b.elevenlabsVoiceCredits;
  acc.openai += b.openai;
  acc.lookup += b.lookup;
  acc.total += b.total;
}
