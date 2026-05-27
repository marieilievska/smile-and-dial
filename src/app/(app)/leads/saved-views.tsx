"use client";

import { useState, useTransition } from "react";
import { BookmarkPlus } from "lucide-react";
import { useSearchParams } from "next/navigation";
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
import { createSavedView } from "@/lib/saved-views/actions";

export type SavedView = { id: string; name: string; params: string };

/** "Save current view" trigger. The list of saved views moved to the
 *  sidebar (close/saved-views-sidebar PR α), so this toolbar control
 *  shrinks to just the create affordance.
 *
 *  Renders only when there's something to save — at least one filter,
 *  search term, sort, or column override on the URL. */
export function SaveCurrentViewButton() {
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  const params = searchParams.toString();
  // Don't show on the bare /leads URL — nothing to save yet.
  if (!params) return null;

  function saveCurrent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "");
    startTransition(async () => {
      const result = await createSavedView("leads", name, params);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("View saved. It appears in the sidebar under Leads.");
        setOpen(false);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        title="Save the current search, filters, sort, and columns as a sidebar view"
      >
        <BookmarkPlus className="size-4" />
        Save view
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save this view</DialogTitle>
          <DialogDescription>
            Save the current search, filters, sort, and columns as a named view
            in the sidebar. One click to come back to it.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={saveCurrent} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="view-name">View name</Label>
            <Input
              id="view-name"
              name="name"
              required
              autoFocus
              placeholder="e.g. Open callbacks in NY/NJ"
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save view"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Re-export for backward compat with code that still imports SavedViews.
export const SavedViews = SaveCurrentViewButton;
