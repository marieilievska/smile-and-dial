import { outcomeLabel as centralOutcomeLabel } from "@/lib/labels";

/**
 * Outcome values an admin can pick from the manual-override dropdown
 * on the call detail modal. Kept in a non-"use server" file so client
 * components can import it directly.
 *
 * Labels live in src/lib/labels.ts so every surface (Calls list,
 * Leads list, Lead detail, this modal) shows the same human-facing
 * string for the same enum value.
 */
export const OVERRIDABLE_OUTCOMES = [
  "voicemail",
  "no_answer",
  "busy",
  "failed",
  "hung_up_immediately",
  "hung_up_later",
  "invalid_number",
  "gatekeeper",
  "gatekeeper_not_interested",
  "not_interested",
  "callback",
  "dnc",
  "goal_met",
  "language_barrier",
  "ai_receptionist",
  "ai_error",
  "transferred_to_human",
] as const;

export type OverridableOutcome = (typeof OVERRIDABLE_OUTCOMES)[number];

export function outcomeLabel(value: string): string {
  return centralOutcomeLabel(value);
}

/**
 * CANONICAL outcome groupings — the single source of truth for every metric
 * surface (Analytics, Calls stat strip, Today pace strip). Previously each page
 * defined its own divergent sets, so one call could be "connected" on one page
 * and not another (the 100% / 0% / 75% connect-rate bug). Import these; do not
 * re-declare locally.
 */

/** A live human actually answered — the "connect" in connect rate. INCLUDES
 *  dnc (a person answered to ask not to be called). EXCLUDES no-pickup / machine
 *  outcomes: voicemail, no_answer, busy, failed, invalid_number, and
 *  ai_receptionist (a bot answered, not a person). hung_up_immediately and
 *  hung_up_later both count — a person did pick up.
 *
 *  ai_error is DELIBERATELY EXCLUDED (2026-08-11, Marija): it's OUR platform/
 *  quota failure, not a real connect. Counting it as connected let a credit
 *  outage (hundreds of ai_error in an hour) masquerade as good calls. It is
 *  not counted as a connect ANYWHERE; the metric surfaces also drop it from the
 *  connect-rate denominator so an outage neither inflates nor tanks the rate. */
export const CONNECTED_OUTCOMES = new Set<string>([
  "goal_met",
  "callback",
  "call_back_later",
  "not_interested",
  "gatekeeper",
  "gatekeeper_not_interested",
  "transferred_to_human",
  "language_barrier",
  "hung_up_immediately",
  "hung_up_later",
  "dnc",
]);

/** OUR platform failures — not real calls. Excluded from the connect-rate
 *  DENOMINATOR (and numerator) so an ElevenLabs credit/quota outage that kills
 *  hundreds of calls doesn't distort connect rate in either direction. Today
 *  this is just ai_error (the only quota/credit-termination outcome). */
export const NON_CALL_OUTCOMES = new Set<string>(["ai_error"]);

/** Reached a real, qualifying two-way conversation. Excludes the brush-off
 *  (call_back_later) and the instant hang-up — those connected but weren't a
 *  real conversation. */
export const CONVERSATION_OUTCOMES = new Set<string>([
  "goal_met",
  "callback",
  "not_interested",
  "gatekeeper",
  "gatekeeper_not_interested",
  "transferred_to_human",
  "language_barrier",
]);

/** No human was reached — a machine answered (voicemail or an AI receptionist
 *  bot), nobody picked up, or the call failed. We don't mirror the AI's
 *  "extracted data" (decision maker, sentiment, …) to the lead for these: a
 *  voicemail greeting or a bot's replies yield no real info, and the analysis
 *  LLM only guessed values because it's forced to. */
export const NO_HUMAN_OUTCOMES = new Set<string>([
  "voicemail",
  "no_answer",
  "busy",
  "failed",
  "invalid_number",
  "ai_error",
  "ai_receptionist",
]);
