/** Max chars of agent instructions fed to the checklist derivation. Real agent
 *  playbooks run ~17-19k chars, so this must cover a whole prompt (not truncate
 *  half of it); it's a backstop against a pathologically huge prompt, not a cost
 *  knob. */
export const INSTRUCTIONS_CAP = 24000;

/** Hard-cap instructions length. Null passes through. */
export function truncateInstructions(
  text: string | null,
  cap: number,
): string | null {
  if (text == null) return null;
  return text.length > cap ? text.slice(0, cap) : text;
}
