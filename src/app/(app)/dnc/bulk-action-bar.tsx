"use client";

import { useState, useTransition } from "react";
import { Download, Trash2, X } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { bulkRemoveFromDnc } from "@/lib/dnc/actions";

import { useSelection } from "./selection";

/**
 * The bar that appears above the DNC table when one or more entries are
 * checked. Offers export-selected for everyone and an admin-only bulk
 * remove with a required reason.
 */
export function DncBulkActionBar({ isAdmin }: { isAdmin: boolean }) {
  const { selected, clear } = useSelection();
  const count = selected.size;
  if (count === 0) return null;
  const ids = [...selected];

  function exportSelected() {
    const qs = new URLSearchParams({ ids: ids.join(",") });
    const link = document.createElement("a");
    link.href = `/dnc/export?${qs.toString()}`;
    link.click();
  }

  return (
    <div className="border-border bg-muted/40 flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2">
      <span className="text-foreground text-sm font-medium">
        {count} selected
      </span>
      <div className="flex-1" />

      <Button variant="outline" size="sm" onClick={exportSelected}>
        <Download className="size-4" />
        Export selected
      </Button>

      {isAdmin ? (
        <BulkRemoveDialog
          count={count}
          onRemove={async (reasonText) => {
            const result = await bulkRemoveFromDnc({ ids, reasonText });
            if (result.error) toast.error(result.error);
            else {
              toast.success(
                `Removed ${result.removed ?? count} ${
                  (result.removed ?? count) === 1 ? "number" : "numbers"
                } from DNC.`,
              );
              clear();
            }
          }}
        />
      ) : null}

      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Clear selection"
        onClick={clear}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}

function BulkRemoveDialog({
  count,
  onRemove,
}: {
  count: number;
  onRemove: (reasonText: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reasonText, setReasonText] = useState("");
  const [pending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      await onRemove(reasonText);
      setOpen(false);
      setReasonText("");
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Trash2 className="size-4" />
          Remove from DNC
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Remove {count} {count === 1 ? "number" : "numbers"} from DNC?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Required: write a short reason. It will be logged once per number to
            the audit trail and cannot be edited later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="dnc-bulk-reason">Reason</Label>
          <Textarea
            id="dnc-bulk-reason"
            value={reasonText}
            onChange={(event) => setReasonText(event.target.value)}
            rows={3}
            placeholder="Why are these numbers coming off the DNC list?"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending || !reasonText.trim()}
            onClick={confirm}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
