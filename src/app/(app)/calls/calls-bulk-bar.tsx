"use client";

import { CheckCheck, RotateCcw, Trash2, X } from "lucide-react";
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
import { markCallsReviewed } from "@/lib/review/actions";

import { useCallsSelection } from "./calls-selection";

/**
 * Sticky bar that appears when one or more calls are selected (admin-only).
 * Always offers a (confirm-gated) permanent delete. In review context — when a
 * `reviewFlag` bucket is being viewed — it also offers bulk "Mark reviewed" /
 * "Reopen", which clear (or restore) the selected calls in the review queue
 * without opening each one.
 */
export function CallsBulkBar({ reviewFlag = "" }: { reviewFlag?: string }) {
  const { selected, clear } = useCallsSelection();
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const count = selected.size;
  if (count === 0) return null;

  const inReview = Boolean(reviewFlag);

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

  function onReviewed(reviewed: boolean) {
    const ids = [...selected];
    startTransition(async () => {
      const r = await markCallsReviewed({ callIds: ids, reviewed });
      if (r.error) {
        toast.error(r.error);
        return;
      }
      const n = r.updated || ids.length;
      toast.success(
        reviewed
          ? `Marked ${n} call${n === 1 ? "" : "s"} reviewed.`
          : `Reopened ${n} call${n === 1 ? "" : "s"}.`,
      );
      clear();
      router.refresh();
    });
  }

  return (
    <div className="pointer-events-none sticky bottom-4 z-20 flex justify-center">
      <div className="border-border bg-card pointer-events-auto flex items-center gap-3 rounded-2xl border px-4 py-2 shadow-lg">
        <span className="text-foreground text-sm font-medium tabular-nums">
          {count} selected
        </span>
        {inReview ? (
          <>
            <Button
              type="button"
              size="sm"
              disabled={pending}
              onClick={() => onReviewed(true)}
              data-testid="calls-bulk-mark-reviewed"
            >
              <CheckCheck className="size-4" />
              Mark reviewed
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => onReviewed(false)}
              data-testid="calls-bulk-reopen"
            >
              <RotateCcw className="size-4" />
              Reopen
            </Button>
            <span className="bg-border h-5 w-px" aria-hidden />
          </>
        ) : null}
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
