"use client";

import { useState, useTransition } from "react";
import { Bookmark, Plus, Trash2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { createSavedView, deleteSavedView } from "@/lib/saved-views/actions";

export type SavedView = { id: string; name: string; params: string };

export function SavedViews({ views }: { views: SavedView[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);

  function applyView(params: string) {
    setPopoverOpen(false);
    router.push(params ? `/leads?${params}` : "/leads");
  }

  function remove(id: string) {
    startTransition(async () => {
      const result = await deleteSavedView(id);
      if (result.error) toast.error(result.error);
      else toast.success("View deleted.");
    });
  }

  function saveCurrent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "");
    const current = searchParams.toString();
    startTransition(async () => {
      const result = await createSavedView("leads", name, current);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("View saved.");
        setSaveOpen(false);
      }
    });
  }

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline">
            <Bookmark className="size-4" />
            Views
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64">
          <div className="flex flex-col gap-1">
            {views.length > 0 ? (
              views.map((view) => (
                <div key={view.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => applyView(view.params)}
                    className="hover:bg-muted flex-1 truncate rounded-md px-2 py-1.5 text-left text-sm"
                  >
                    {view.name}
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete view ${view.name}`}
                    disabled={pending}
                    onClick={() => remove(view.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))
            ) : (
              <p className="text-muted-foreground px-2 py-1.5 text-sm">
                No saved views yet
              </p>
            )}
            <div className="border-border mt-1 border-t pt-1">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  setPopoverOpen(false);
                  setSaveOpen(true);
                }}
              >
                <Plus className="size-4" />
                Save current view
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save view</DialogTitle>
            <DialogDescription>
              Save the current search, filters, sorting, and columns as a named
              view.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={saveCurrent} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="view-name">View name</Label>
              <Input id="view-name" name="name" required />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : "Save view"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
