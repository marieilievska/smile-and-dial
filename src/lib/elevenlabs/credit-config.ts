/**
 * Env-overridable configuration for the ElevenLabs credit guard. Numbers are
 * EL credits (EL renamed "characters" to "credits" but kept the field names).
 * Defaults are the "balanced" posture (see the design spec): stop with ~one
 * dialing round in reserve, warn well before that, resume with hysteresis.
 */
function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export type CreditConfig = {
  /** Below this: warn admins, keep dialing. */
  warn: number;
  /** Below this: pause campaigns, stop dialing. */
  stop: number;
  /** At/above this again: auto-resume (must be >= stop for hysteresis). */
  resume: number;
  /** How long a confirmed balance is trusted when live reads fail before the
   *  guard stops dialing. */
  staleMinutes: number;
  /** Used only to render "~N calls left" in alerts. */
  avgCreditsPerCall: number;
};

export function creditConfig(): CreditConfig {
  return {
    warn: envNum("EL_CREDIT_WARN_THRESHOLD", 100_000),
    stop: envNum("EL_CREDIT_STOP_THRESHOLD", 35_000),
    resume: envNum("EL_CREDIT_RESUME_THRESHOLD", 50_000),
    staleMinutes: envNum("EL_CREDIT_STALE_MINUTES", 15),
    avgCreditsPerCall: envNum("EL_AVG_CREDITS_PER_CALL", 530),
  };
}

/** Render a credit balance as an approximate call count for alert copy. */
export function callsLeft(
  remaining: number,
  avgCreditsPerCall: number,
): number {
  if (avgCreditsPerCall <= 0) return 0;
  return Math.max(0, Math.round(remaining / avgCreditsPerCall));
}
