import "server-only";

import type { PromptEdit } from "./types";

/** Never more than this many anchored edits per suggestion — one targeted
 *  change may need a couple of operations, but a long list means the model is
 *  rewriting, not editing. */
export const MAX_SUGGESTION_EDITS = 4;

function clip(s: string): string {
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

/**
 * Validate + apply anchored edits in one pass. Edits apply sequentially, each
 * validated against the WORKING text (so a later anchor may target text an
 * earlier edit produced). Returns the edited prompt, or a human-readable error
 * (also fed back to the model on its one retry). The AI cannot touch anything
 * outside its anchors by construction — the rest is copied byte-for-byte.
 */
export function applyPromptEdits(
  prompt: string,
  edits: PromptEdit[],
): { result: string | null; error: string | null } {
  if (edits.length === 0) {
    return { result: null, error: "No edits were proposed." };
  }
  if (edits.length > MAX_SUGGESTION_EDITS) {
    return {
      result: null,
      error: `No more than ${MAX_SUGGESTION_EDITS} edits are allowed.`,
    };
  }
  let out = prompt;
  for (const e of edits) {
    if (!e.text.trim()) {
      return { result: null, error: "An edit has empty replacement text." };
    }
    if (e.type === "append") {
      out = `${out.trimEnd()}\n\n${e.text.trim()}`;
      continue;
    }
    if (!e.anchor.trim()) {
      return {
        result: null,
        error: `A ${e.type} edit is missing its anchor text.`,
      };
    }
    const first = out.indexOf(e.anchor);
    if (first === -1) {
      return {
        result: null,
        error: `Anchor text was not found verbatim in the prompt: "${clip(e.anchor)}"`,
      };
    }
    if (out.indexOf(e.anchor, first + e.anchor.length) !== -1) {
      return {
        result: null,
        error: `Anchor text appears more than once in the prompt: "${clip(e.anchor)}"`,
      };
    }
    out =
      e.type === "replace"
        ? out.slice(0, first) + e.text + out.slice(first + e.anchor.length)
        : out.slice(0, first + e.anchor.length) +
          "\n" +
          e.text +
          out.slice(first + e.anchor.length);
  }
  return { result: out, error: null };
}
