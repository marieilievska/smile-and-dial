/**
 * Pure "at most once per interval" helpers for the alerting paths in the
 * dialer tick. No I/O, no clock of their own (callers pass `now`) so they can
 * be unit-tested directly. The DB-side twin is `alert_fire()` (SQL), which
 * does the same thing atomically for rules that must dedupe across ticks and
 * across the SQL evaluator.
 */

/** How often the tick re-checks the ElevenLabs post-call webhook. */
export const WEBHOOK_HEALTH_CHECK_INTERVAL_MS = 10 * 60 * 1000;

/** dialer_heartbeats rows older than this are pruned on the insert path. */
export const HEARTBEAT_RETENTION_DAYS = 7;

/**
 * True when something last done at `lastAtIso` is due again: never done,
 * an unparseable timestamp (treat unknown as due rather than silently
 * never running), or at least `intervalMs` ago.
 */
export function isDue(
  lastAtIso: string | null | undefined,
  intervalMs: number,
  now: Date = new Date(),
): boolean {
  if (!lastAtIso) return true;
  const last = new Date(lastAtIso).getTime();
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= intervalMs;
}

/** ISO cutoff for the heartbeat prune: `days` before `now`. */
export function heartbeatPruneCutoff(
  now: Date = new Date(),
  days: number = HEARTBEAT_RETENTION_DAYS,
): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}
