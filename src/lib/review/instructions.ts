import type { ReviewFlagDef } from "./types";

/** The built-in flag for "agent didn't follow its own instructions". */
export const OFF_SCRIPT_KEY = "off_script";

/** Max chars of agent instructions fed to the reviewer. Real agent playbooks run
 *  ~14k chars, so this must cover a whole prompt (not truncate half of it); it's
 *  a backstop against a pathologically huge prompt, not a cost knob. */
export const INSTRUCTIONS_CAP = 20000;

/** The rubric defs the reviewer should use: off_script only makes sense when we
 *  actually have the agent's instructions to judge against. */
export function rubricDefsForReview(
  defs: ReviewFlagDef[],
  hasInstructions: boolean,
): ReviewFlagDef[] {
  return hasInstructions ? defs : defs.filter((d) => d.key !== OFF_SCRIPT_KEY);
}

/** Hard-cap instructions length. Null passes through. */
export function truncateInstructions(
  text: string | null,
  cap: number,
): string | null {
  if (text == null) return null;
  return text.length > cap ? text.slice(0, cap) : text;
}

/** True when the cached prompt is missing or older than `days`. */
export function isCacheStale(
  cachedAt: string | null,
  nowMs: number,
  days: number,
): boolean {
  if (!cachedAt) return true;
  const t = new Date(cachedAt).getTime();
  if (Number.isNaN(t)) return true;
  return nowMs - t > days * 24 * 3600_000;
}
