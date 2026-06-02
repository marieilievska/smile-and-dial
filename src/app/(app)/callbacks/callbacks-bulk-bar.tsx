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
import { deleteCallbacks } from "@/lib/callbacks/actions";

import { useCallbacksSelection } from "./callbacks-selection";

/**
 * Sticky bar that appears when one or more callbacks are selected (admin-only).
 * Permanently deletes them after a confirm. Pending callbacks hand their lead
 * back to the queue (handled server-side).
 */
export function CallbacksBulkBar() {
  const { selected, clear } = useCallbacksSelection();
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const count = selected.size;
  if (count === 0) return null;

  function onConfirm() {
    const ids = [...selected];
    startTransition(async () => {
      const r = await deleteCallbacks(ids);
      if (r.error) {
        toast.error(r.error);
        return;
      }
      const n = r.deleted ?? ids.length;
      toast.success(`Deleted ${n} callback${n === 1 ? "" : "s"}.`);
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
              data-testid="callbacks-bulk-delete"
            >
              <Trash2 className="size-4" />
              Delete
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Delete {count} callback{count === 1 ? "" : "s"}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                This permanently removes the selected callback
                {count === 1 ? "" : "s"}. Any pending one
                {count === 1 ? "" : "s"} will hand the lead back to the standard
                queue. This cannot be undone.
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
