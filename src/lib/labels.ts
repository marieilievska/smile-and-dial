/** Single source of truth for human-facing labels of every enum value
 *  the app shows in tables, filters, pills, and detail panels.
 *
 *  Generic title-casing (capitalize first letter, replace underscores)
 *  produces "Dnc" and "Ai error" — which read as amateur. Hard-coding
 *  the labels lets us spell acronyms correctly (DNC, AI, DM) and use
 *  the same string everywhere the user sees it. */

export const LEAD_STATUS_LABELS: Record<string, string> = {
  ready_to_call: "Ready to call",
  callback: "Callback",
  resting: "Resting",
  goal_met: "Goal met",
  attended: "Attended",
  no_show: "No show",
  closed: "Closed",
  sale: "Sale",
  dnc: "DNC",
  email_replied: "Email replied",
};

export const CALL_STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  dialing: "Dialing",
  ringing: "Ringing",
  in_progress: "In progress",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const OUTCOME_LABELS: Record<string, string> = {
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
  dm_reached: "DM reached",
};

/** Fallback humanizer for any string the lookup tables don't cover.
 *  Title-cases the first letter, replaces underscores with spaces.
 *  Used by helpers below and by code that occasionally needs to
 *  humanize an unknown / dynamic value. */
export function humanizeFallback(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ");
}

export function leadStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return LEAD_STATUS_LABELS[status] ?? humanizeFallback(status);
}

export function callStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return CALL_STATUS_LABELS[status] ?? humanizeFallback(status);
}

export function outcomeLabel(outcome: string | null | undefined): string {
  if (!outcome) return "—";
  return OUTCOME_LABELS[outcome] ?? humanizeFallback(outcome);
}
