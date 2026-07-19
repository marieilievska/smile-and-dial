export type ReviewFlagDef = {
  key: string;
  label: string;
  lens: "bug" | "compliance" | "quality" | "opportunity" | "voc";
  severity: number;
  guidance: string;
};

/** A finding Pass 1 proposed. `step_key` names the playbook step for a
 *  `playbook_missed` finding, and is null for the fixed delivery checks. */
export type ProposedFinding = {
  flag_key: string;
  step_key: string | null;
  evidence_quote: string;
  confidence: number;
};

/** A finding after Pass 2 verification. */
export type VerifiedFinding = {
  flag_key: string;
  step_key: string | null;
  evidence_quote: string;
  confidence: number;
  status: "confirmed" | "needs_review";
};

/** One anchored edit to an agent's system prompt. The AI may ONLY express its
 *  change this way — everything outside the named anchor is untouchable.
 *   - replace:      swap the (unique, verbatim) anchor passage for `text`
 *   - insert_after: insert `"\n" + text` right after the anchor passage
 *   - append:       add `text` at the very end (anchor is ignored; send "")
 */
export type PromptEdit = {
  type: "replace" | "insert_after" | "append";
  anchor: string;
  text: string;
};
