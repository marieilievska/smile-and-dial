"use client";

import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GOAL_STATUSES, type GoalStatus } from "@/lib/goals/goal-statuses";
import { transitionLeadGoalStatus } from "@/lib/goals/pipeline-actions";

const LABELS: Record<GoalStatus, string> = {
  goal_met: "Goal met",
  attended: "Attended",
  no_show: "No-show",
  sale: "Sale",
  closed: "Closed",
};

/** Per-row "advance status" control on the Goals pipeline. Renders a
 *  dropdown with the goal statuses; picking one updates the lead. */
export function GoalStatusActions({
  leadId,
  currentStatus,
}: {
  leadId: string;
  currentStatus: GoalStatus;
}) {
  const [pending, startTransition] = useTransition();

  function pick(status: GoalStatus) {
    if (status === currentStatus) return;
    startTransition(async () => {
      const result = await transitionLeadGoalStatus({ leadId, status });
      if (result.error) toast.error(result.error);
      else toast.success(`Marked ${LABELS[status]}.`);
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          aria-label="Change goal status"
        >
          Set status
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {GOAL_STATUSES.map((status) => (
          <DropdownMenuItem
            key={status}
            disabled={status === currentStatus}
            onClick={() => pick(status)}
          >
            {LABELS[status]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
