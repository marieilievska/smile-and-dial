import type { GoalStatus } from "@/lib/goals/goal-statuses";

/** Goal-pipeline status palette, matching the semantic system used on
 *  Calls / Callbacks / Leads:
 *   - goal_met   → coral    (active hand-off, needs follow-up)
 *   - attended   → coral    (active follow-up in progress)
 *   - no_show    → destructive (rebooking needed)
 *   - sale       → success  (win!)
 *   - closed     → secondary (audit done) */
export function goalStatusVariant(
  status: GoalStatus,
): "coral" | "success" | "destructive" | "secondary" {
  switch (status) {
    case "goal_met":
    case "attended":
      return "coral";
    case "no_show":
      return "destructive";
    case "sale":
      return "success";
    case "closed":
      return "secondary";
  }
}

export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  goal_met: "Goal met",
  attended: "Attended",
  no_show: "No show",
  sale: "Sale",
  closed: "Closed",
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
