/**
 * Whether a finished call should schedule an immediate redial of the same lead
 * from the same number ("double calling").
 *
 * Pure, so the rule is testable without a database — this decides whether a
 * second real phone call gets placed, so it earns its own tests.
 *
 * See docs/superpowers/specs/2026-07-27-double-call-design.md
 */

/** Retry-cycle positions that get doubled: the opener and the step before the
 *  15-day gap. Position 1 (the middle 2-day step) is left as a single call. */
const DOUBLED_POSITIONS = new Set([0, 2]);

export function shouldScheduleRedial(input: {
  /** The campaign's opt-in. */
  doubleCallEnabled: boolean;
  /** The finished call's outcome. */
  outcome: string | null;
  /** Whether the finished call was ITSELF the second half of a pair. */
  isRedial: boolean;
  /** The lead's retry_position BEFORE the cycle advanced for this call. */
  retryPositionBefore: number;
}): boolean {
  if (!input.doubleCallEnabled) return false;
  // Voicemail only. no_answer is arguably the same from the lead's side, and
  // busy is indistinguishable from a manual decline on most carriers — see the
  // spec's Decisions section.
  if (input.outcome !== "voicemail") return false;
  // A pair is two calls, never three.
  if (input.isRedial) return false;
  return DOUBLED_POSITIONS.has(((input.retryPositionBefore % 3) + 3) % 3);
}
