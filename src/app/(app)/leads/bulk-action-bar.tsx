"use client";

import { useState, useTransition } from "react";
import { Ban, Download, FolderInput, Trash2, UserCog, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  bulkDeleteLeads,
  bulkMoveToList,
  bulkReassignOwner,
} from "@/lib/leads/bulk-actions";
import { bulkAddLeadsToDnc } from "@/lib/dnc/actions";

import { useSelection } from "./selection";

type BulkResult = { error: string | null };
type Option = { id: string; name: string };

/**
 * The bar that appears above the leads table when one or more leads are
 * selected. Offers move-to-list, reassign-owner (admins only), soft-delete,
 * and export of just the selected rows.
 */
export function BulkActionBar({
  lists,
  owners,
  isAdmin,
}: {
  lists: Option[];
  owners: Option[];
  isAdmin: boolean;
}) {
  const { selected, clear } = useSelection();
  const searchParams = useSearchParams();
  const count = selected.size;

  if (count === 0) return null;
  const ids = [...selected];

  function exportSelected() {
    const qs = new URLSearchParams({ ids: ids.join(",") });
    const cols = searchParams.get("cols");
    if (cols) qs.set("cols", cols);
    const link = document.createElement("a");
    link.href = `/leads/export?${qs.toString()}`;
    link.click();
  }

  // v2 — sticky bottom bar (Linear-style). When 1+ leads are selected,
  // a coral-accented bar slides up from the viewport bottom. It floats
  // above the table so the user can scroll-pick-act without losing
  // their selection bar.
  return (
    <div
      data-testid="bulk-action-bar"
      className="animate-in slide-in-from-bottom-2 bg-card fixed inset-x-0 bottom-4 z-40 mx-auto flex w-fit max-w-[95vw] flex-wrap items-center gap-2 rounded-xl border px-3 py-2 shadow-lg duration-200"
      style={{
        borderColor: "color-mix(in oklab, var(--coral) 40%, transparent)",
        boxShadow:
          "0 8px 32px -8px color-mix(in oklab, var(--coral) 25%, transparent), 0 4px 12px -2px rgba(0,0,0,0.08)",
      }}
    >
      <span
        className="text-foreground inline-flex items-center gap-1.5 text-sm font-medium"
        aria-live="polite"
      >
        <span
          aria-hidden
          className="size-1.5 rounded-full"
          style={{ backgroundColor: "var(--coral)" }}
        />
        {count} selected
      </span>
      <div className="bg-border/60 mx-1 h-5 w-px" />

      <PickApplyDialog
        triggerLabel="Move to list"
        triggerIcon={<FolderInput className="size-4" />}
        title={`Move ${count} ${count === 1 ? "lead" : "leads"}`}
        selectLabel="List"
        placeholder="Choose a list"
        applyLabel="Move"
        options={lists}
        onApply={async (listId) => {
          const result = await bulkMoveToList({ leadIds: ids, listId });
          if (!result.error) clear();
          return result;
        }}
      />

      {isAdmin ? (
        <PickApplyDialog
          triggerLabel="Reassign owner"
          triggerIcon={<UserCog className="size-4" />}
          title={`Reassign ${count} ${count === 1 ? "lead" : "leads"}`}
          selectLabel="Owner"
          placeholder="Choose an owner"
          applyLabel="Reassign"
          options={owners}
          onApply={async (ownerId) => {
            const result = await bulkReassignOwner({ leadIds: ids, ownerId });
            if (!result.error) clear();
            return result;
          }}
        />
      ) : null}

      <Button
        variant="outline"
        size="sm"
        onClick={async () => {
          const result = await bulkAddLeadsToDnc({ leadIds: ids });
          if (result.error) toast.error(result.error);
          else {
            toast.success(
              `Added ${result.added ?? ids.length} ${result.added === 1 ? "number" : "numbers"} to DNC.`,
            );
            clear();
          }
        }}
      >
        <Ban className="size-4" />
        Add to DNC
      </Button>

      <Button variant="outline" size="sm" onClick={exportSelected}>
        <Download className="size-4" />
        Export selected
      </Button>

      <DeleteSelectedDialog
        count={count}
        onDelete={async () => {
          const result = await bulkDeleteLeads({ leadIds: ids });
          if (!result.error) clear();
          return result;
        }}
      />

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

/** A dialog that picks one option from a list and applies it to the selection. */
function PickApplyDialog({
  triggerLabel,
  triggerIcon,
  title,
  selectLabel,
  placeholder,
  applyLabel,
  options,
  onApply,
}: {
  triggerLabel: string;
  triggerIcon: React.ReactNode;
  title: string;
  selectLabel: string;
  placeholder: string;
  applyLabel: string;
  options: Option[];
  onApply: (id: string) => Promise<BulkResult>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [pending, startTransition] = useTransition();

  function apply() {
    if (!value) return;
    startTransition(async () => {
      const result = await onApply(value);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(`${applyLabel} complete.`);
        setOpen(false);
        setValue("");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {triggerIcon}
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Pick where the selected leads should go.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="bulk-pick">{selectLabel}</Label>
          <Select value={value} onValueChange={setValue}>
            <SelectTrigger id="bulk-pick">
              <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button onClick={apply} disabled={pending || !value}>
            {pending ? "Saving…" : applyLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Confirmation dialog for soft-deleting the selected leads. */
function DeleteSelectedDialog({
  count,
  onDelete,
}: {
  count: number;
  onDelete: () => Promise<BulkResult>;
}) {
  const [pending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      const result = await onDelete();
      if (result.error) toast.error(result.error);
      else toast.success("Leads deleted.");
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Trash2 className="size-4" />
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete {count} {count === 1 ? "lead" : "leads"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Deleted leads are removed from the Leads page.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={confirm} disabled={pending}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
