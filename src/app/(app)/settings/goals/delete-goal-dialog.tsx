"use client";

import { Trash2 } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { deleteGoal } from "@/lib/goals/actions";

/** Delete a goal definition.
 *
 *  Round 10 — accepts `usageCount`. If the goal is referenced by at
 *  least one active campaign the trigger button is disabled with a
 *  "reassign campaigns first" tooltip — the server-side action would
 *  also reject the delete, but blocking at the UI prevents the user
 *  from staring at an unhelpful toast. */
export function DeleteGoalDialog({
  goal,
  usageCount = 0,
}: {
  goal: { id: string; name: string };
  usageCount?: number;
}) {
  const [pending, startTransition] = useTransition();
  const blocked = usageCount > 0;

  function onConfirm() {
    startTransition(async () => {
      try {
        const result = await deleteGoal(goal.id);
        if (result.error) toast.error(result.error);
        else toast.success("Goal deleted.");
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Delete ${goal.name}`}
          disabled={blocked}
          title={
            blocked
              ? `In use by ${usageCount} active campaign${usageCount === 1 ? "" : "s"} — reassign before deleting.`
              : `Delete ${goal.name}`
          }
          className="text-destructive hover:bg-destructive/10 hover:text-destructive disabled:text-muted-foreground disabled:hover:bg-transparent"
        >
          <Trash2 className="size-4" />
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete &ldquo;{goal.name}&rdquo;?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the goal. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={pending}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
