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
