/**
 * Did a single call reach the decision maker? This is a PURE flag, completely
 * independent of the call's disposition/outcome. It is TRUE only when the
 * post-call analysis read the transcript and recorded decision_maker_reached =
 * "yes" (i.e. the person we spoke with said they're the owner or a manager).
 * Everything else — "no" / "unknown" / blank — is FALSE. ("DM reached" is NOT an
 * outcome; the disposition is a separate thing. Operators set this flag manually
 * via the lead toggle; this function is the automatic, transcript-driven path.)
 */
export function callReachedDm(
  extracted: Record<string, unknown> | null | undefined,
  outcome?: string | null,
): boolean {
  // The OUTCOME vetoes a stray AI flag. A gatekeeper (or a firm gatekeeper
  // decline) is BY DEFINITION not the owner/manager, and the machine/no-pickup
  // outcomes reached nobody — so even a mis-extracted decision_maker_reached=
  // "yes" on such a call must NOT count as reaching the decision maker. This is
  // the main source of gatekeepers being counted as DMs. (not_interested is
  // NOT excluded — it's owner-only by definition; see OUTCOME_IMPLIES_DM.)
  if (outcome != null && OUTCOME_EXCLUDES_DM.has(outcome)) return false;
  const v = extracted?.decision_maker_reached;
  return typeof v === "string" && v.trim().toLowerCase() === "yes";
}

/** Outcomes whose very DEFINITION means we reached the decision maker, so they
 *  imply decision_maker_reached even when the AI didn't set the standalone flag
 *  (it usually doesn't — it only writes "yes" a handful of the time). Keep this
 *  in lockstep with the disposition prompt in agents.ts:
 *  - not_interested: defined as "the DECISION MAKER … clearly declined". A
 *    gatekeeper brush-off is `gatekeeper`, so not_interested is only ever the
 *    owner/manager saying no — which means we reached them.
 *  goal_met is intentionally NOT here: a goal can be met by a non-decision-maker
 *  (a survey answered, a slot booked by front desk), and we report goals-with-DM
 *  as a separate, deliberately-narrower number. */
export const OUTCOME_IMPLIES_DM = new Set<string>(["not_interested"]);

/** Outcomes that DEFINITIONALLY did NOT reach the decision maker. A gatekeeper
 *  / gatekeeper_not_interested is a NON-owner/manager by definition; the machine,
 *  no-pickup, and platform-error outcomes reached nobody. A call with one of
 *  these can never be a DM contact, regardless of the AI's extracted flag —
 *  which is how a gatekeeper the AI mis-flagged was being counted as a DM. */
export const OUTCOME_EXCLUDES_DM = new Set<string>([
  "gatekeeper",
  "gatekeeper_not_interested",
  "voicemail",
  "no_answer",
  "busy",
  "failed",
  "invalid_number",
  "ai_receptionist",
  "ai_error",
  "hung_up_immediately",
  "hung_up_later",
]);

/** Does this call's OUTCOME by itself imply we reached the decision maker? */
export function outcomeImpliesDm(outcome: string | null | undefined): boolean {
  return outcome != null && OUTCOME_IMPLIES_DM.has(outcome);
}

/** True when ANY of the lead's calls reached the decision maker — either the AI
 *  explicitly flagged it, OR the outcome definitionally implies it (see
 *  OUTCOME_IMPLIES_DM). The lead-level flag reflects this: once any call reached
 *  the DM, the lead has. */
export function anyCallReachedDm(
  calls: {
    extracted_data: unknown;
    outcome?: string | null;
  }[],
): boolean {
  return calls.some(
    (c) =>
      callReachedDm(
        (c.extracted_data ?? null) as Record<string, unknown> | null,
        c.outcome,
      ) || outcomeImpliesDm(c.outcome),
  );
}
