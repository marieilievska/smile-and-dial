"use client";

import { Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
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
import { deleteCalls } from "@/lib/calls/actions";

import { useCallsSelection } from "./calls-selection";

/**
 * Sticky bar that appears when one or more calls are selected (admin-only).
 * Permanently deletes the selected calls after a confirm — calls are audit
 * history, so deletion is gated behind an explicit dialog.
 */
export function CallsBulkBar() {
  const { selected, clear } = useCallsSelection();
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const count = selected.size;
  if (count === 0) return null;

  function onConfirm() {
    const ids = [...selected];
    startTransition(async () => {
      const r = await deleteCalls(ids);
      if (r.error) {
        toast.error(r.error);
        return;
      }
      const n = r.deleted ?? ids.length;
      toast.success(`Deleted ${n} call${n === 1 ? "" : "s"}.`);
      clear();
      router.refresh();
    });
  }

  return (
    <div className="pointer-events-none sticky bottom-4 z-20 flex justify-center">
      <div className="border-border bg-card pointer-events-auto flex items-center gap-3 rounded-full border px-4 py-2 shadow-lg">
        <span className="text-foreground text-sm font-medium tabular-nums">
          {count} selected
        </span>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={pending}
              data-testid="calls-bulk-delete"
            >
              <Trash2 className="size-4" />
              Delete
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Delete {count} call{count === 1 ? "" : "s"}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                This permanently removes the selected call
                {count === 1 ? "" : "s"} and any recording
                {count === 1 ? "" : "s"}, and drops{" "}
                {count === 1 ? "it" : "them"} from cost and analytics totals.
                This cannot be undone.
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
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={clear}
          aria-label="Clear selection"
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}
