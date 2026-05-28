"use client";

import { CalendarPlus, MoveRight, PhoneCall } from "lucide-react";
import { useRouter } from "next/navigation";
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

import { GOAL_STATUS_LABELS, nextGoalStatus } from "./status-variant";

/** Per-row action cluster on the goals pipeline. Hover-only on the
 *  table view; always-visible on the board cards.
 *
 *  Layout:
 *   - Smart primary (coral): the natural next step for the current
 *     status. E.g. on a `goal_met` row, "Mark attended". Hidden for
 *     no_show (needs rebooking, not a status flip) and closed
 *     (terminal).
 *   - For no_show specifically: a "Call again" coral button instead,
 *     since the natural next action is to redial.
 *   - Set status dropdown (ghost): all statuses, including backwards
 *     transitions and skipping ahead.
 *
 *  Round 13 — dropped "View original call" from the dropdown. The
 *  table view already exposes that as a dedicated column, so duplicating
 *  it inside the dropdown was just noise. The leadId prop is still
 *  used by the no_show "Call again" button. */
export function GoalStatusActions({
  leadId,
  currentStatus,
  variant = "row",
}: {
  leadId: string;
  currentStatus: GoalStatus;
  /** `row` = hover-only on a table row; `card` = always visible on a
   *  kanban card. */
  variant?: "row" | "card";
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const next = nextGoalStatus(currentStatus);

  function stop(event: React.SyntheticEvent) {
    event.stopPropagation();
  }

  function transition(event: React.MouseEvent, status: GoalStatus) {
    event.stopPropagation();
    if (status === currentStatus) return;
    startTransition(async () => {
      const result = await transitionLeadGoalStatus({ leadId, status });
      if (result.error) toast.error(result.error);
      else toast.success(`Marked ${GOAL_STATUS_LABELS[status]}.`);
    });
  }

  function callAgain(event: React.MouseEvent) {
    event.stopPropagation();
    router.push(`/leads/${leadId}?action=call`);
  }

  const sizeCls = variant === "card" ? "h-7 px-2 text-xs" : "h-7 px-2";

  return (
    <div
      data-testid="goal-row-actions"
      onClick={stop}
      onKeyDown={stop}
      className={
        variant === "row"
          ? "ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
          : "flex flex-wrap items-center gap-1"
      }
    >
      {/* Smart primary action — depends on current status. */}
      {currentStatus === "no_show" ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={callAgain}
          disabled={pending}
          className={`${sizeCls} text-primary hover:bg-primary/10 hover:text-primary`}
          title="Call again to rebook"
        >
          <PhoneCall className="size-3.5" />
          Call again
        </Button>
      ) : next ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={(e) => transition(e, next.next)}
          disabled={pending}
          className={`${sizeCls} text-primary hover:bg-primary/10 hover:text-primary`}
          title={next.label}
        >
          <MoveRight className="size-3.5" />
          {next.label}
        </Button>
      ) : null}

      {/* Set status dropdown — covers backward transitions + skipping. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            className={sizeCls}
            aria-label="Change goal status"
            onClick={stop}
          >
            Set status
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={stop}>
          {GOAL_STATUSES.map((status) => (
            <DropdownMenuItem
              key={status}
              disabled={status === currentStatus}
              onClick={(e) => transition(e, status)}
            >
              {GOAL_STATUS_LABELS[status]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Compact "View original call" link rendered as a row icon — used on
 *  the table view when there's space, separately from the dropdown
 *  fallback inside GoalStatusActions. */
export function ViewOriginalCallLink({ callId }: { callId: string | null }) {
  if (!callId) return <span className="text-muted-foreground text-xs">—</span>;
  return (
    <a
      href={`/calls?call=${callId}`}
      onClick={(e) => e.stopPropagation()}
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
    >
      <CalendarPlus className="size-3" />
      View
    </a>
  );
}
