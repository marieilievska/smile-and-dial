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

/** Outcomes whose post-call side effect writes a dnc_entries row. MIRROR of the
 *  DNC family in src/lib/elevenlabs/post-call-webhook.ts (dncReasonForOutcome). */
const DNC_FAMILY = new Set(["dnc", "invalid_number", "language_barrier"]);

function structuralFlags({ outcome, extracted, leadHasBooking, hasCallbackRow, status, hasDncEntry = false, callbackScheduledInPast = false }) {
  const out = [];
  const dm = dmOf(extracted);

  // The phone is on the DNC list because of THIS call, but the call isn't a
  // DNC-family outcome — the list, the lead and the label disagree. 2026-09-10:
  // the agent's mark_dnc tool fired for LGNDS Studios while the classifier
  // filed the call ai_receptionist (a bot answered, then transferred to the
  // owner), so the lead sat "resting" with its number blocked.
  if (hasDncEntry && !DNC_FAMILY.has(outcome)) {
    out.push({
      type: "dnc_entry_not_dnc",
      reason: `a dnc_entries row cites this call but outcome=${outcome ?? "null"} → read, then relabel or remove the entry`,
    });
  }

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

  // A callback booked for a time that has ALREADY PASSED is due the moment it
  // is written, so the dialer rings straight back. 2026-09-11: Divine Warrior
  // Ninjutsu got three calls in four minutes that way ("You just called me
  // three times in a row") and asked for the DNC list. All three cases that day
  // were leads an hour ahead of Eastern, so a relative time ("in 20 minutes")
  // read as lead-local lands in the past.
  if (outcome === "callback" && callbackScheduledInPast) {
    out.push({
      type: "callback_in_past",
      reason: "callback scheduled BEFORE it was created → dialer redials immediately (check the lead's time zone)",
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
  // The agent offered removal but the call ISN'T dnc. If the person said yes,
  // they were promised no more calls and will get them anyway (2026-09-10:
  // River-City MMA, and LGNDS under ai_receptionist).
  if (outcome !== "dnc" && S.agentOfferedRemoval(transcript)) {
    out.push({
      type: "agent_offer_not_dnc",
      reason: `agent offered removal but outcome=${outcome ?? "null"} → did they accept? (promised no more calls)`,
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

module.exports = { structuralFlags, transcriptFlags, dmOf, DNC_FAMILY };
