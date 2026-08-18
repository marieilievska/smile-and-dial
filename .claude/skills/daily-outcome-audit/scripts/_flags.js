// Pure per-call flag predicates for the audit triage. A flag marks a call whose
// LABEL contradicts a signal the AI already recorded — "a human should read this
// one". structuralFlags needs no transcript; transcriptFlags does (pulled in
// triage's second phase). All pure — unit-tested in _flags.test.js.
const S = require("./_signals");

/** The decision-maker enum the extractor records: "yes" | "no" | "unknown" | absent. */
const dmOf = (extracted) => {
  const v = extracted && extracted.decision_maker_reached;
  return typeof v === "string" ? v.trim().toLowerCase() : null;
};

function structuralFlags({ outcome, extracted, leadHasBooking, hasCallbackRow, status }) {
  const out = [];
  const dm = dmOf(extracted);

  // not_interested is owner-only by definition; if the AI didn't confirm the
  // owner (dm != yes), it's likely a gatekeeper decline. (Phase 2 enforces this
  // in the classifier; until then triage flags + suggests the relabel.)
  if (outcome === "not_interested" && dm !== "yes") {
    out.push({
      type: "not_interested_dm_not_yes",
      reason: `not_interested but dm=${dm ?? "absent"} → likely gatekeeper_not_interested`,
      suggest: "gatekeeper_not_interested",
    });
  }

  // Reverse: a gatekeeper decline where the AI said it DID reach the owner.
  if (outcome === "gatekeeper_not_interested" && dm === "yes") {
    out.push({
      type: "gni_dm_yes",
      reason: "gatekeeper_not_interested but dm=yes → read (owner decline? mis-extract?)",
    });
  }

  // goal_met must have a real booking.
  if (outcome === "goal_met" && !leadHasBooking) {
    out.push({
      type: "goal_met_no_booking",
      reason: "goal_met but lead has NO Calendly booking → false win / failed booking",
    });
  }

  // A callback with no time strands the lead (dialer has nothing to dial).
  if (outcome === "callback" && !(extracted && extracted.callback_datetime) && !hasCallbackRow) {
    out.push({
      type: "callback_no_time",
      reason: "callback with no callback_datetime and no callbacks row → stranded",
    });
  }

  // A completed call must never have a null outcome (should be zero post-#394).
  if ((outcome == null || outcome === "") && status === "completed") {
    out.push({
      type: "null_outcome",
      reason: "completed call with null outcome → stranded (should be zero)",
    });
  }

  return out;
}

function transcriptFlags({ outcome, transcript }) {
  const out = [];
  if (outcome === "dnc" && S.agentOfferedRemoval(transcript)) {
    out.push({
      type: "dnc_agent_offer",
      reason: "dnc where an AGENT turn offered removal → agent-manufactured?",
    });
  }
  if (outcome === "voicemail" && S.genuineHumanReplyCount(transcript) >= 2) {
    out.push({
      type: "voicemail_has_human",
      reason: "voicemail with >=2 genuine human replies → human reached then mailbox → gatekeeper",
    });
  }
  return out;
}

module.exports = { structuralFlags, transcriptFlags, dmOf };
