/**
 * Pure decision function for the ElevenLabs credit guard. No I/O — given the
 * current remaining credits and the previous state, it returns the new state,
 * whether the dialer may place calls, and which one-shot transition (if any)
 * fired so the orchestrator knows what side effect to run.
 *
 * Hysteresis: once "low", we stay low until credits climb back to `resume`
 * (> `stop`), so the dialer can't flap paused/active right at the stop line.
 */
export type CreditState = "ok" | "warn" | "low";

export type CreditTransition =
  | "none"
  | "entered_warn"
  | "entered_low"
  | "still_low"
  | "resumed";

export type CreditDecision = {
  state: CreditState;
  shouldDial: boolean;
  transition: CreditTransition;
};

export function evaluateCreditState(
  remaining: number,
  prevState: CreditState | null,
  t: { warn: number; stop: number; resume: number },
): CreditDecision {
  let state: CreditState;
  if (prevState === "low") {
    // Hold "low" until we've recovered to the resume line.
    if (remaining >= t.resume) {
      state = remaining >= t.warn ? "ok" : "warn";
    } else {
      state = "low";
    }
  } else if (remaining < t.stop) {
    state = "low";
  } else if (remaining < t.warn) {
    state = "warn";
  } else {
    state = "ok";
  }

  let transition: CreditTransition = "none";
  if (state === "low") {
    transition = prevState === "low" ? "still_low" : "entered_low";
  } else if (prevState === "low") {
    transition = "resumed";
  } else if (state === "warn" && prevState !== "warn") {
    // prevState is "ok" or null here (the "low" cases are handled above).
    transition = "entered_warn";
  }

  return { state, shouldDial: state !== "low", transition };
}
