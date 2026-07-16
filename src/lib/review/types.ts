export type ReviewFlagDef = {
  key: string;
  label: string;
  lens: "bug" | "compliance" | "quality" | "opportunity" | "voc";
  severity: number;
  guidance: string;
};

/** A flag Pass 1 proposed. */
export type ProposedFlag = {
  flag_key: string;
  evidence_quote: string;
  confidence: number;
};

/** A flag after Pass 2 verification. */
export type VerifiedFlag = {
  flag_key: string;
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
