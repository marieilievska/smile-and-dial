"use client";

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
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createListInline } from "@/lib/lists/actions";

/** Small dialog the import wizard uses to create a new list inline.
 *  Trigger is rendered by the parent; this component owns the dialog
 *  open state via controlled props so the parent can fire it from a
 *  dropdown item or an empty-state CTA without duplicating logic.
 *
 *  On success calls `onCreated(id, name)` with the new list so the
 *  parent can auto-select it in the list dropdown. */
export function CreateListInlineDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onCreated: (id: string, name: string) => void;
}) {
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    startTransition(async () => {
      const result = await createListInline(trimmed);
      if (result.error || !result.id) {
        toast.error(result.error ?? "Could not create the list.");
        return;
      }
      toast.success(`List "${trimmed}" created.`);
      onCreated(result.id, trimmed);
      setName("");
      onOpenChange(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setName("");
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a new list</DialogTitle>
          <DialogDescription>
            Lists group leads by where they came from, what campaign they belong
            to, or any other slice you find useful.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="inline-list-name">List name</Label>
            <Input
              id="inline-list-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Cold gyms NY"
              autoFocus
              required
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? "Creating…" : "Create list"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
