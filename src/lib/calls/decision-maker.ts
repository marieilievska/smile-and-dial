/**
 * Did a single call reach the decision maker? TRUE only when the agent
 * explicitly confirmed it ("decision_maker_reached" = "yes"), or the call was
 * deliberately marked with the "dm_reached" outcome (including a manual
 * override). We no longer INFER it from goal_met / not_interested / callback /
 * etc. — those over-claimed: a gatekeeper can decline on the owner's behalf, and
 * a research survey can be completed without ever reaching the owner. Any other
 * read ("no" / "unknown" / blank) means we did NOT confirm a DM contact;
 * operators flip it manually when they know better. Shared by the post-call
 * webhook, the manual outcome override, and the call-deletion recompute.
 */
export function callReachedDm(
  outcome: string | null | undefined,
  extracted: Record<string, unknown> | null | undefined,
): boolean {
  const v = extracted?.decision_maker_reached;
  if (typeof v === "string" && v.trim().toLowerCase() === "yes") return true;
  return outcome === "dm_reached";
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
