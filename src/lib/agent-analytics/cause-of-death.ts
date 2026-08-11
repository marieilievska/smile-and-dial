// Pure cause-of-death assignment. No DB, no React — unit-tested in isolation.
//
// Each worked lead gets ONE primary cause = the furthest stage it reached. A
// lead's `status` already encodes "still being worked" (ready_to_call / callback)
// vs "finished" (resting / dnc / goal_met), so no retry-counting is needed.

/** The causes a worked lead can land in (`won` shown for contrast). */
export type CauseKey =
  | "won"
  | "opted_out"
  | "dm_said_no"
  | "callback_booked"
  | "mid_follow_up"
  | "gatekeeper"
  | "bad_number"
  | "brush_off"
  | "other"
  | "never_reached";

export type CauseGroup = "won" | "final" | "in_play";

/** Which group each cause belongs to (drives the scoreboard grouping). */
export const CAUSE_GROUP: Record<CauseKey, CauseGroup> = {
  won: "won",
  opted_out: "final",
  dm_said_no: "final",
  gatekeeper: "final",
  bad_number: "final",
  brush_off: "final",
  other: "final",
  never_reached: "final",
  callback_booked: "in_play",
  mid_follow_up: "in_play",
};

/** Human labels for the tab. */
export const CAUSE_LABEL: Record<CauseKey, string> = {
  won: "Won (goal met)",
  opted_out: "Opted out (DNC)",
  dm_said_no: "Decision-maker said no",
  gatekeeper: "Blocked by gatekeeper",
  bad_number: "Bad number",
  brush_off: "Brush-off (no real conversation)",
  other: "Other (language / bot / error)",
  never_reached: "Never reached anyone",
  callback_booked: "Callback booked",
  mid_follow_up: "Mid follow-up",
};

/** Display order within each group. */
export const CAUSE_ORDER: CauseKey[] = [
  "won",
  "dm_said_no",
  "gatekeeper",
  "brush_off",
  "never_reached",
  "bad_number",
  "opted_out",
  "other",
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

export type CauseResult = {
  total: number;
  counts: Record<CauseKey, number>;
  groups: Record<CauseGroup, number>;
  perLead: { leadId: string; cause: CauseKey }[];
};

// Positive/terminal lead statuses that are wins or still engaged, NOT losses —
// so a booked sale or appointment (with an earlier "not interested" call, say)
// isn't miscounted as a rejection. `leads.status` is written beyond the core
// dialer states by the Goals pipeline (sale/attended/closed), Calendly
// (scheduled) and the Close webhook (email_replied).
const WON_STATUSES = new Set(["goal_met", "sale", "attended", "closed"]);
const IN_PLAY_STATUSES = new Set([
  "ready_to_call",
  "scheduled",
  "email_replied",
]);
// Reached a person but no real conversation / no commitment yet.
const BRUSH_OFF_OUTCOMES = new Set([
  "call_back_later",
  "hung_up_immediately",
  "callback",
]);
const OTHER_OUTCOMES = new Set([
  "language_barrier",
  "ai_receptionist",
  "ai_error",
]);
const NEVER_REACHED_OUTCOMES = new Set([
  "voicemail",
  "no_answer",
  "busy",
  "failed",
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
  if (!lead.decisionMakerReached && has("gatekeeper")) return "gatekeeper";
  if (lead.outcomes.some((o) => BRUSH_OFF_OUTCOMES.has(o))) return "brush_off";
  if (lead.outcomes.some((o) => OTHER_OUTCOMES.has(o))) return "other";
  if (has("invalid_number")) return "bad_number";
  if (
    lead.outcomes.length > 0 &&
    lead.outcomes.every((o) => NEVER_REACHED_OUTCOMES.has(o))
  )
    return "never_reached";

  return "other";
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
    brush_off: 0,
    other: 0,
    never_reached: 0,
  };
  const groups: Record<CauseGroup, number> = { won: 0, final: 0, in_play: 0 };
  const perLead: { leadId: string; cause: CauseKey }[] = [];

  for (const lead of leads) {
    const cause = assignCause(lead);
    counts[cause] += 1;
    groups[CAUSE_GROUP[cause]] += 1;
    perLead.push({ leadId: lead.leadId, cause });
  }

  return { total: leads.length, counts, groups, perLead };
}
