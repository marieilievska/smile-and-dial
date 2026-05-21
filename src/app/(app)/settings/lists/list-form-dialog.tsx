"use client";

import { useState, useTransition } from "react";
import { Pencil, Plus } from "lucide-react";
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

type ListData = { id: string; name: string; description: string | null };

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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit list" : "New list"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update this list's name or description."
              : "Create a list to group leads together."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="list-name">Name</Label>
            <Input
              id="list-name"
              name="name"
              defaultValue={list?.name ?? ""}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="list-description">Description</Label>
            <Textarea
              id="list-description"
              name="description"
              defaultValue={list?.description ?? ""}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : isEdit ? "Save changes" : "Create list"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
