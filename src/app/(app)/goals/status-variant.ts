import type { GoalStatus } from "@/lib/goals/goal-statuses";

/** Goal-pipeline status palette — the single source of truth for how
 *  each pipeline status reads visually across the app (table, board,
 *  lead detail badge, leads-list pill).
 *
 *  Semantics:
 *   - goal_met   → coral        (active hand-off, needs human follow-up)
 *   - attended   → success      (positive milestone — they actually showed)
 *   - no_show    → warning      (didn't attend; needs rebooking attention,
 *                                but not lost)
 *   - sale       → success      (the win)
 *   - closed     → destructive  (closed lost — didn't convert) */
export function goalStatusVariant(
  status: GoalStatus,
): "coral" | "success" | "warning" | "destructive" {
  switch (status) {
    case "goal_met":
      return "coral";
    case "attended":
      return "success";
    case "no_show":
      return "warning";
    case "sale":
      return "success";
    case "closed":
      return "destructive";
  }
}

export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  goal_met: "Goal met",
  attended: "Attended",
  no_show: "No show",
  sale: "Sale",
  // "Closed lost" is unambiguous (vs. plain "Closed", which an SDR
  // could read as "successfully closed out"). Renamed in round 11.
  closed: "Closed lost",
};

/** The "natural next step" for each status. Drives the primary
 *  coral action on each pipeline row. Returns null when there's no
 *  obvious forward move (Closed is terminal). */
export function nextGoalStatus(status: GoalStatus): {
  next: GoalStatus;
  label: string;
} | null {
  switch (status) {
    case "goal_met":
      return { next: "attended", label: "Mark attended" };
    case "attended":
      return { next: "sale", label: "Mark sale" };
    case "no_show":
      // No-show needs rebooking, not a direct status flip — the row
      // surfaces a "Reschedule" link instead. Skip the smart-primary.
      return null;
    case "sale":
      return { next: "closed", label: "Close out" };
    case "closed":
      return null;
  }
}
