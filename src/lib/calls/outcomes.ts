/**
 * Outcome values an admin can pick from the manual-override dropdown
 * on the call detail modal. Kept in a non-"use server" file so client
 * components can import it directly.
 */
export const OVERRIDABLE_OUTCOMES = [
  "voicemail",
  "no_answer",
  "busy",
  "failed",
  "hung_up_immediately",
  "invalid_number",
  "gatekeeper",
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

const OUTCOME_LABELS: Record<OverridableOutcome, string> = {
  voicemail: "Voicemail",
  no_answer: "No answer",
  busy: "Busy",
  failed: "Failed",
  hung_up_immediately: "Hung up immediately",
  invalid_number: "Invalid number",
  gatekeeper: "Gatekeeper",
  not_interested: "Not interested",
  callback: "Callback",
  dnc: "DNC",
  goal_met: "Goal met",
  language_barrier: "Language barrier",
  ai_receptionist: "AI receptionist",
  ai_error: "AI error",
  transferred_to_human: "Transferred to human",
};

export function outcomeLabel(value: string): string {
  return OUTCOME_LABELS[value as OverridableOutcome] ?? value;
}
