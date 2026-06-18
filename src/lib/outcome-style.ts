/** Single source of truth for the *colors* (Badge variants + score
 *  tones) of every call outcome and pipeline/call/callback status the
 *  app renders. Labels live in `labels.ts`; this module is colors only.
 *
 *  Why this exists: the same call outcome and the same lead status used
 *  to render with different colors on different pages (the calls log
 *  colored outcomes by sentiment, while leads / callbacks / goals each
 *  had their own local `statusVariant`). An operator saw a "goal met"
 *  badge green on one page and coral on another. Centralizing the
 *  variant logic here keeps every surface consistent.
 *
 *  Variant token names map to the shadcn Badge variants in
 *  `components/ui/badge.tsx`: default | secondary | destructive |
 *  success | warning | coral | outline | ghost | link. Do not return a
 *  token the Badge doesn't define.
 *
 *  There are FOUR distinct semantic axes here — they are intentionally
 *  separate functions because the same word can mean different things:
 *    1. Call OUTCOME (what the AI/human heard on the call)
 *    2. Call lifecycle STATUS (queued/ringing/completed/failed…)
 *    3. Lead pipeline STATUS (ready_to_call/goal_met/sale/dnc…)
 *    4. Callback record STATUS (pending/completed/missed/cancelled)
 *  Campaign lifecycle status (active/paused/draft/ended) is a FIFTH axis
 *  that lives locally in campaigns/campaign-cells.tsx — it's a different
 *  concept (a whole campaign, not a single contact) and folding it in
 *  here would invite mis-coloring, so it is deliberately left out. */

/** Variants the shadcn Badge supports for these status/outcome pills. */
export type StatusBadgeVariant =
  | "success"
  | "destructive"
  | "secondary"
  | "warning"
  | "coral";

// ── Call outcome ────────────────────────────────────────────────────
// Outcomes are colored into four meaningful tiers so the call log reads
// at a glance — color carries the category, the label carries the detail
// (not a unique color per value):
//   green  (success)     = a win / forward progress
//   amber  (warning)     = didn't connect to a person, worth another try
//   red    (destructive) = failed / a hard no
//   grey   (secondary)   = truly neutral / unknown only

/** WIN (green) — the goal was met, they agreed to a callback, or we
 *  handed off to a human. */
const POSITIVE_OUTCOMES = new Set([
  "goal_met",
  "transferred_to_human",
  "callback",
]);

/** FAILED / HARD NO (red) — a clear no, an unusable number, or an error:
 *  the call failed to connect, the number was invalid, they're not
 *  interested, do-not-call, or the AI errored. */
const NEGATIVE_OUTCOMES = new Set([
  "failed",
  "invalid_number",
  "not_interested",
  "dnc",
  "ai_error",
]);

/** DIDN'T CONNECT — RETRY (amber) — we reached a machine, a screener, or
 *  nobody, so there's no result yet but it's worth another attempt:
 *  voicemail, no answer, busy, an immediate hang-up, a gatekeeper, a
 *  "call back later", a language barrier, or an AI receptionist. */
const RETRY_OUTCOMES = new Set([
  "voicemail",
  "no_answer",
  "busy",
  "hung_up_immediately",
  "gatekeeper",
  "call_back_later",
  "language_barrier",
  "ai_receptionist",
]);

// NEUTRAL (grey) is the fallback for any unknown / unmapped outcome only.

/** Badge variant for a call OUTCOME, colored into four tiers:
 *  green (success) = win, amber (warning) = didn't connect / retry,
 *  red (destructive) = failed / hard no, grey (secondary) = unknown. */
export function outcomeBadgeVariant(
  outcome: string,
): "success" | "warning" | "destructive" | "secondary" {
  if (POSITIVE_OUTCOMES.has(outcome)) return "success"; // green
  if (NEGATIVE_OUTCOMES.has(outcome)) return "destructive"; // red
  if (RETRY_OUTCOMES.has(outcome)) return "warning"; // amber
  // Any unknown / unmapped outcome reads grey.
  return "secondary";
}

// ── Call lifecycle status ───────────────────────────────────────────

/** Badge variant for a CALL's lifecycle status (the Twilio/dialer
 *  state, not the outcome): coral while the dialer is actively on the
 *  line (queued/dialing/ringing/in_progress), red for failed/cancelled,
 *  grey for everything else (completed, unknown). */
export function callStatusBadgeVariant(
  status: string,
): "coral" | "secondary" | "destructive" {
  if (["queued", "dialing", "ringing", "in_progress"].includes(status)) {
    return "coral";
  }
  if (status === "failed" || status === "cancelled") return "destructive";
  return "secondary";
}

// ── Lead pipeline status ────────────────────────────────────────────

/** Badge variant for a LEAD's pipeline status. Reconciles the three
 *  formerly-local mappings (leads list, lead detail, goals pipeline)
 *  into one palette:
 *   - ready_to_call / callback / goal_met / scheduled → coral (active
 *     work — the AI/operator is still moving the lead forward, or the
 *     handoff just happened and needs human follow-up)
 *   - attended / sale → success (positive milestone — they showed / they
 *     bought)
 *   - no_show → warning (didn't attend; needs rebooking, but not lost)
 *   - dnc / closed → destructive (do-not-call / closed lost — terminal
 *     negative)
 *   - everything else (resting, email_replied, unknown) → secondary
 *
 *  This is a strict SUPERSET of every prior local mapping, so no lead
 *  status changes color on any surface. `scheduled` came from the lead
 *  detail copy; the goals palette agrees on every overlapping key. */
export function leadStatusBadgeVariant(status: string): StatusBadgeVariant {
  if (["ready_to_call", "callback", "goal_met", "scheduled"].includes(status)) {
    return "coral";
  }
  if (["attended", "sale"].includes(status)) return "success";
  if (status === "no_show") return "warning";
  if (["dnc", "closed"].includes(status)) return "destructive";
  return "secondary";
}

// ── Callback record status ──────────────────────────────────────────

/** Badge variant for a CALLBACK record's own status (a different axis
 *  from the lead's pipeline status):
 *   - pending   → coral (active work — owed appointment)
 *   - completed → success (we made it)
 *   - missed    → destructive (we missed the appointment)
 *   - cancelled → secondary (audit trail, not actionable) */
export function callbackStatusBadgeVariant(
  status: string,
): "coral" | "success" | "destructive" | "secondary" {
  switch (status) {
    case "pending":
      return "coral";
    case "completed":
      return "success";
    case "missed":
      return "destructive";
    case "cancelled":
    default:
      return "secondary";
  }
}

// ── Score tone ──────────────────────────────────────────────────────

/** Tailwind text-color tone for a call's 0–10 score so a good call
 *  reads at a glance instead of as a bare decimal. 8+ = strong
 *  (emerald), 5–7.9 = okay (amber), below 5 = weak (rose). Null scores
 *  stay muted. */
export function scoreTone(score: number | null): string {
  if (score == null) return "text-muted-foreground";
  if (score >= 8) return "text-emerald-600 dark:text-emerald-400";
  if (score >= 5) return "text-amber-600 dark:text-amber-400";
  return "text-rose-600 dark:text-rose-400";
}
