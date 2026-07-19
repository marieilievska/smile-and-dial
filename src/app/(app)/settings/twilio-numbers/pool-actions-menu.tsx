"use client";

import {
  Ban,
  Flag,
  Loader2,
  MoreVertical,
  Moon,
  RotateCcw,
  Sun,
} from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  activatePoolNumber,
  retirePoolNumber,
  setPoolNumberFlag,
  setPoolNumberRest,
} from "@/lib/twilio/pool-actions";

/** Per-row pool-state controls for an in-pool (non-released) number: rest/wake,
 *  flag/unflag for rotation, retire/reactivate. Every item is CONTEXTUAL — its
 *  label and the action it fires flip based on the number's current pool state,
 *  so the menu never shows a no-op. Mirrors the run()/useTransition/toast pattern
 *  from settings/users/user-row-actions.tsx; retiring uses destructive styling
 *  since it pulls the number out of dial selection. */
export function PoolActionsMenu({
  number,
}: {
  number: {
    id: string;
    pool_status: string;
    flagged_for_rotation: boolean;
    rested_until: string | null;
  };
}) {
  const [pending, startTransition] = useTransition();
  const isResting = Boolean(
    number.rested_until && new Date(number.rested_until) > new Date(),
  );
  const isRetired = number.pool_status === "retired";

  function run(
    action: () => Promise<{ error: string | null }>,
    success: string,
  ) {
    startTransition(async () => {
      try {
        const result = await action();
        if (result.error) toast.error(result.error);
        else toast.success(success);
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={pending}
          aria-label="Pool actions"
        >
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <MoreVertical className="size-3.5" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {isResting ? (
          <DropdownMenuItem
            disabled={pending}
            onSelect={() =>
              run(() => setPoolNumberRest(number.id, 0), "Number woken up.")
            }
          >
            <Sun /> Wake now
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            disabled={pending}
            onSelect={() =>
              run(
                () => setPoolNumberRest(number.id, 24),
                "Number resting for 24h.",
              )
            }
          >
            <Moon /> Rest 24h
          </DropdownMenuItem>
        )}
        {number.flagged_for_rotation ? (
          <DropdownMenuItem
            disabled={pending}
            onSelect={() =>
              run(() => setPoolNumberFlag(number.id, false), "Unflagged.")
            }
          >
            <Flag /> Unflag
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            disabled={pending}
            onSelect={() =>
              run(
                () => setPoolNumberFlag(number.id, true),
                "Flagged for rotation.",
              )
            }
          >
            <Flag /> Flag for rotation
          </DropdownMenuItem>
        )}
        {isRetired ? (
          <DropdownMenuItem
            disabled={pending}
            onSelect={() =>
              run(() => activatePoolNumber(number.id), "Reactivated.")
            }
          >
            <RotateCcw /> Reactivate
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            variant="destructive"
            disabled={pending}
            onSelect={() =>
              run(() => retirePoolNumber(number.id), "Retired from pool.")
            }
          >
            <Ban /> Retire from pool
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
