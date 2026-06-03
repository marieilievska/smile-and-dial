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
  "invalid_number",
  "gatekeeper",
  "dm_reached",
  "not_interested",
  "callback",
  "call_back_later",
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

/** A live human (or human screener) actually answered — the "connect" in
 *  connect rate. EXCLUDES machine / no-pickup outcomes: voicemail, no_answer,
 *  busy, failed, invalid_number, ai_error, and ai_receptionist (a bot answered,
 *  not a person). hung_up_immediately counts — a person did pick up. */
export const CONNECTED_OUTCOMES = new Set<string>([
  "goal_met",
  "callback",
  "call_back_later",
  "not_interested",
  "gatekeeper",
  "dm_reached",
  "transferred_to_human",
  "language_barrier",
  "hung_up_immediately",
]);

/** Reached a real, qualifying two-way conversation. Excludes the brush-off
 *  (call_back_later) and the instant hang-up — those connected but weren't a
 *  real conversation. */
export const CONVERSATION_OUTCOMES = new Set<string>([
  "goal_met",
  "callback",
  "not_interested",
  "gatekeeper",
  "dm_reached",
  "transferred_to_human",
  "language_barrier",
]);

/** Spoke with the decision maker (outcome-level proxy). */
export const DM_REACHED_OUTCOMES = new Set<string>([
  "goal_met",
  "not_interested",
  "callback",
  "dnc",
  "transferred_to_human",
  "dm_reached",
]);
