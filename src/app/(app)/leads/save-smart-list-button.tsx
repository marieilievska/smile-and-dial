"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
      toast.success("Smart list saved.");
      setOpen(false);
      setName("");
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline">
          Save as Smart List
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save smart list</DialogTitle>
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
