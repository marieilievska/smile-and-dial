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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { saveSmartList } from "@/lib/smart-lists/actions";
import type { Group } from "@/lib/smart-lists/recipe";

export function SaveSmartListButton({ recipeJson }: { recipeJson: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, start] = useTransition();

  function save() {
    let recipe: Group;
    try {
      recipe = JSON.parse(recipeJson) as Group;
    } catch {
      toast.error("Filter is invalid.");
      return;
    }
    start(async () => {
      const res = await saveSmartList({ name, recipe });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Saved. Attach it to a campaign to start calling it.");
      setOpen(false);
      setName("");
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          Save as auto-updating list
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save as an auto-updating list</DialogTitle>
          {/* This dialog is where most people meet the idea for the first
              time, so it says what the thing DOES rather than naming a
              category. "Smart list" told a business owner nothing. */}
          <DialogDescription>
            Any lead that matches this filter joins the list on its own, now and
            later. Attach it to a campaign and the AI keeps calling it as it
            fills up.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Warm — AI interest yes, never called"
        />
        <DialogFooter>
          <Button
            type="button"
            onClick={save}
            disabled={pending || !name.trim()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
