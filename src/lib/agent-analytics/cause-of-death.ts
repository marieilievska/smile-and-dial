// Pure cause-of-death assignment. No DB, no React — unit-tested in isolation.
//
// Each worked lead gets ONE primary cause = the furthest stage it reached. A
// lead's `status` already encodes "still being worked" (ready_to_call / callback)
// vs "finished" (resting / dnc / goal_met), so no retry-counting is needed.
//
// 2026-08-12 (Marija): simplified from 10 causes to 7 — the fuzzy trio
// (brush_off / never_reached / other) collapsed into ONE "No real contact"
// bucket, with the finer reason kept as a sub-reason for the why-detail. Each
// cause now carries a plain-English description + a suggested next action.

/** The causes a worked lead can land in (`won` shown for contrast). */
export type CauseKey =
  | "won"
  | "opted_out"
  | "dm_said_no"
  | "callback_booked"
  | "mid_follow_up"
  | "gatekeeper"
  | "bad_number"
  | "no_contact";

export type CauseGroup = "won" | "final" | "in_play";

/** Which group each cause belongs to (drives the scoreboard grouping). */
export const CAUSE_GROUP: Record<CauseKey, CauseGroup> = {
  won: "won",
  opted_out: "final",
  dm_said_no: "final",
  gatekeeper: "final",
  bad_number: "final",
  no_contact: "final",
  callback_booked: "in_play",
  mid_follow_up: "in_play",
};

/** Human labels for the tab. */
export const CAUSE_LABEL: Record<CauseKey, string> = {
  won: "Won (goal met)",
  opted_out: "Opted out (DNC)",
  dm_said_no: "Decision-maker said no",
  gatekeeper: "Gatekeeper wall",
  bad_number: "Bad number",
  no_contact: "No real contact",
  callback_booked: "Callback booked",
  mid_follow_up: "Mid follow-up",
};

/** One plain-English sentence: what this cause MEANS. */
export const CAUSE_DESCRIPTION: Record<CauseKey, string> = {
  won: "The goal was achieved — the decision-maker booked / registered.",
  opted_out: "The business asked to be removed from the list (do-not-call).",
  dm_said_no: "We reached the owner or a manager and they declined the offer.",
  gatekeeper:
    "We got a person, but never past the front desk to the owner/manager.",
  bad_number: "The number doesn't reach the business (wrong / invalid line).",
  no_contact:
    "No real conversation happened — a machine answered, nobody picked up, or they hung up before we could talk.",
  callback_booked: "A callback is scheduled — still a live opportunity.",
  mid_follow_up: "Still being worked — in the retry cycle, not lost yet.",
};

/** The suggested next move for each cause (empty when there's nothing to do). */
export const CAUSE_ACTION: Record<CauseKey, string> = {
  won: "",
  opted_out: "Nothing to do — honor the opt-out.",
  dm_said_no:
    "Look at the objections below — if it's timing/price, a later re-approach or a different angle may re-open it.",
  gatekeeper:
    "Try different call hours, ask for the owner's name/direct line, or route to a scheduled callback.",
  bad_number: "Re-verify or replace the number; drop it if it stays invalid.",
  no_contact:
    "Retry at better times (see the breakdown below); if it's mostly voicemail/no-answer, the number or timing is the lever.",
  callback_booked: "Make the callback on time.",
  mid_follow_up: "Let the retry cycle run; check pacing if it stalls.",
};

/** Display order within each group. */
export const CAUSE_ORDER: CauseKey[] = [
  "won",
  "dm_said_no",
  "gatekeeper",
  "no_contact",
  "bad_number",
  "opted_out",
  "callback_booked",
  "mid_follow_up",
];

/** The minimal per-lead shape the assignment needs. */
export type LeadForCause = {
  leadId: string;
  status: string; // leads.status
  decisionMakerReached: boolean; // leads.decision_maker_reached
  goalMet: boolean; // any goal_met call
  outcomes: string[]; // its outbound calls' non-null outcome values
};

/** Sub-reasons WITHIN "No real contact" — the furthest we got when there was no
 *  real conversation. Drives the why-detail breakdown under that bucket. */
export type NoContactReason =
  | "brushed_off"
  | "machine"
  | "no_pickup"
  | "error";

export const NO_CONTACT_LABEL: Record<NoContactReason, string> = {
  brushed_off: "Reached a person, but they hung up / brushed us off",
  machine: "A machine answered (voicemail or an automated receptionist)",
  no_pickup: "Nobody picked up (no answer / busy / failed)",
  error: "Language barrier or a platform error",
};

const BRUSHED_OFF = new Set([
  "hung_up_immediately",
  "hung_up_later",
  "call_back_later",
]);
const MACHINE = new Set(["voicemail", "ai_receptionist"]);
const NO_PICKUP = new Set(["no_answer", "busy", "failed"]);
const ERROR = new Set(["language_barrier", "ai_error"]);

/** Furthest sub-reason for a No-real-contact lead (a person > a machine >
 *  no pickup > error). Returns null when none of its outcomes qualify. */
export function noContactReason(outcomes: string[]): NoContactReason | null {
  if (outcomes.some((o) => BRUSHED_OFF.has(o))) return "brushed_off";
  if (outcomes.some((o) => MACHINE.has(o))) return "machine";
  if (outcomes.some((o) => NO_PICKUP.has(o))) return "no_pickup";
  if (outcomes.some((o) => ERROR.has(o))) return "error";
  return null;
}

export type CauseResult = {
  total: number;
  counts: Record<CauseKey, number>;
  groups: Record<CauseGroup, number>;
  perLead: { leadId: string; cause: CauseKey; noContact?: NoContactReason }[];
};

// Positive/terminal lead statuses that are wins or still engaged, NOT losses —
// so a booked sale or appointment (with an earlier "not interested" call, say)
// isn't miscounted as a rejection.
const WON_STATUSES = new Set(["goal_met", "sale", "attended", "closed"]);
const IN_PLAY_STATUSES = new Set([
  "ready_to_call",
  "scheduled",
  "email_replied",
]);

/** Assign one cause to a lead (furthest stage wins; first match returns). */
export function assignCause(lead: LeadForCause): CauseKey {
  const has = (o: string) => lead.outcomes.includes(o);

  // 1. Won / positive terminal status, or handed to a human closer.
  if (
    lead.goalMet ||
    WON_STATUSES.has(lead.status) ||
    has("transferred_to_human")
  )
    return "won";

  // 2. Hard terminal dispositions override an otherwise in-play status.
  if (lead.status === "dnc" || has("dnc")) return "opted_out";
  if (has("not_interested")) return "dm_said_no";

  // 3. Still being worked or positively engaged (status encodes this).
  if (lead.status === "callback") return "callback_booked";
  if (IN_PLAY_STATUSES.has(lead.status)) return "mid_follow_up";

  // 4. Finished (resting / other terminal) → furthest stage reached.
  if (
    !lead.decisionMakerReached &&
    (has("gatekeeper") || has("gatekeeper_not_interested"))
  )
    return "gatekeeper";
  if (has("invalid_number")) return "bad_number";
  // Everything else that reached no real conversation.
  if (lead.outcomes.length > 0) return "no_contact";

  return "no_contact";
}

/** Aggregate a cohort of leads into cause counts, group totals, and per-lead. */
export function computeCauseOfDeath(leads: LeadForCause[]): CauseResult {
  const counts: Record<CauseKey, number> = {
    won: 0,
    opted_out: 0,
    dm_said_no: 0,
    callback_booked: 0,
    mid_follow_up: 0,
    gatekeeper: 0,
    bad_number: 0,
    no_contact: 0,
  };
  const groups: Record<CauseGroup, number> = { won: 0, final: 0, in_play: 0 };
  const perLead: {
    leadId: string;
    cause: CauseKey;
    noContact?: NoContactReason;
  }[] = [];

  for (const lead of leads) {
    const cause = assignCause(lead);
    counts[cause] += 1;
    groups[CAUSE_GROUP[cause]] += 1;
    const entry: { leadId: string; cause: CauseKey; noContact?: NoContactReason } =
      { leadId: lead.leadId, cause };
    if (cause === "no_contact") {
      const r = noContactReason(lead.outcomes);
      if (r) entry.noContact = r;
    }
    perLead.push(entry);
  }

  return { total: leads.length, counts, groups, perLead };
}
