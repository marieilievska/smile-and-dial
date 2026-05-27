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
