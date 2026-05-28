"use client";

import { FileText, FolderPlus, Pencil, Plus } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createList, updateList } from "@/lib/lists/actions";

import { DialogSection } from "../dialog-section";

type ListData = { id: string; name: string; description: string | null };

/** Create/edit dialog for /settings/lists. Round 24 — adopts the
 *  shared DialogSection pattern with coral icon chips so the modal
 *  matches Add-to-DNC and the campaign settings modals. The form
 *  itself is two fields (Name + Description) — no functional
 *  changes, just structure + helpers. */
export function ListFormDialog({
  mode,
  list,
}: {
  mode: "create" | "edit";
  list?: ListData;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const isEdit = mode === "edit";

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "");
    const description = String(data.get("description") ?? "");

    startTransition(async () => {
      try {
        const result =
          isEdit && list
            ? await updateList(list.id, name, description)
            : await createList(name, description);
        if (result.error) {
          toast.error(result.error);
        } else {
          toast.success(isEdit ? "List updated." : "List created.");
          if (!isEdit) form.reset();
          setOpen(false);
        }
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {isEdit ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Edit ${list?.name ?? "list"}`}
          >
            <Pencil className="size-4" />
            Edit
          </Button>
        ) : (
          <Button>
            <Plus className="size-4" />
            New list
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit list" : "New list"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update this list's name or description. Leads attached to it stay where they are."
              : "Lists group leads together. A list is what gets attached to a campaign."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-5">
          <DialogSection
            icon={<FolderPlus className="size-3.5" />}
            title="Name"
            description="Shown on the lists table and in campaign attachment pickers."
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="list-name">Name</Label>
              <Input
                id="list-name"
                name="name"
                defaultValue={list?.name ?? ""}
                placeholder="e.g. January Q1 outbound prospects"
                required
              />
            </div>
          </DialogSection>

          <DialogSection
            icon={<FileText className="size-3.5" />}
            title="Description"
            description="Optional. Helps teammates pick the right list without opening it."
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="list-description">Description</Label>
              <Textarea
                id="list-description"
                name="description"
                defaultValue={list?.description ?? ""}
                rows={3}
                placeholder="e.g. SaaS founders in Series A, sourced from Crunchbase"
              />
            </div>
          </DialogSection>

          <DialogFooter className="flex-row items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : isEdit ? "Save changes" : "Create list"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
