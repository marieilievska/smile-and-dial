/** Curated label map for the known event kinds. Admins shouldn't have
 *  to mentally parse `spend_cap_hit` → "Spend cap hit" at a glance.
 *
 *  Anything not listed falls back to a snake_case → Sentence case
 *  transform, so a new kind shipped behind the scenes still renders
 *  sensibly without a UI update. */
const KIND_LABELS: Record<string, string> = {
  spend_cap_hit: "Spend cap hit",
  spend_cap_resumed: "Spend cap resumed",
  campaign_paused: "Campaign paused",
  number_flagged: "Number flagged",
  connect_rate_low: "Low connect rate",
  webhook_error: "Webhook error",
  dialer_failure: "Dialer failure",
  orphan_call: "Orphan call",
  integration_disconnected: "Integration disconnected",
  goal_transition: "Goal transition",
  callback_changed: "Callback changed",
  outcome_override: "Outcome override",
  call_now: "Call-now requested",
  dnc_removed: "DNC entry removed",
  merge_completed: "Lead merge completed",
};

export function humanizeKind(kind: string): string {
  if (KIND_LABELS[kind]) return KIND_LABELS[kind];
  // Fallback: replace _ with space and capitalize first letter.
  const spaced = kind.replace(/_/g, " ").trim();
  if (!spaced) return kind;
  return spaced[0].toUpperCase() + spaced.slice(1);
}
