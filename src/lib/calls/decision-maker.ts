import { DM_REACHED_OUTCOMES } from "@/lib/calls/outcomes";

/**
 * Did a single call reach the decision maker? Prefer the agent's explicit
 * `decision_maker_reached` capture (only "yes" counts); otherwise fall back to
 * the outcome proxy (goal_met / callback / not_interested / … all imply we got
 * past any gatekeeper to the buyer). Shared by the post-call webhook, the
 * manual outcome override, and the call-deletion recompute so the lead's
 * `decision_maker_reached` flag is derived the same way everywhere.
 */
export function callReachedDm(
  outcome: string | null | undefined,
  extracted: Record<string, unknown> | null | undefined,
): boolean {
  if (extracted && "decision_maker_reached" in extracted) {
    const v = extracted.decision_maker_reached;
    return typeof v === "string" && v.trim().toLowerCase() === "yes";
  }
  return Boolean(outcome && DM_REACHED_OUTCOMES.has(outcome));
}

/** True when ANY of the lead's calls reached the decision maker. The lead-level
 *  flag reflects this — once any call reached the DM, the lead has. */
export function anyCallReachedDm(
  calls: {
    outcome: string | null;
    extracted_data: unknown;
  }[],
): boolean {
  return calls.some((c) =>
    callReachedDm(
      c.outcome,
      (c.extracted_data ?? null) as Record<string, unknown> | null,
    ),
  );
}
