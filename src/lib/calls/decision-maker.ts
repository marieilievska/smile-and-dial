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
): boolean {
  const v = extracted?.decision_maker_reached;
  return typeof v === "string" && v.trim().toLowerCase() === "yes";
}

/** True when ANY of the lead's calls reached the decision maker. The lead-level
 *  flag reflects this — once any call reached the DM, the lead has. */
export function anyCallReachedDm(
  calls: {
    extracted_data: unknown;
  }[],
): boolean {
  return calls.some((c) =>
    callReachedDm((c.extracted_data ?? null) as Record<string, unknown> | null),
  );
}
