"use client";

import { Pencil } from "lucide-react";
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
import { renameNumber } from "@/lib/twilio/number-actions";

/** Give a number a human label (e.g. "Alabama outbound") so the pool reads
 *  clearly instead of as a wall of digits. Clearing the field resets the
 *  label to the formatted phone number. */
export function RenameNumberDialog({
  number,
}: {
  number: { id: string; phone_number: string; friendly_name: string };
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(number.friendly_name);
  const [pending, startTransition] = useTransition();

  function onSave() {
    startTransition(async () => {
      try {
        const result = await renameNumber({ id: number.id, name });
        if (result.error) {
          toast.error(result.error);
        } else {
          toast.success("Number renamed.");
          setOpen(false);
        }
      } catch {
        toast.error("Something went wrong. Please try again.");
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Reset the field to the saved name whenever the dialog reopens.
        if (next) setName(number.friendly_name);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Rename ${number.phone_number}`}
        >
          <Pencil className="size-4" />
          Rename
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename {number.phone_number}</DialogTitle>
          <DialogDescription>
            Give this number a label that says what it&apos;s for — like
            &ldquo;Alabama outbound&rdquo; or &ldquo;Sales line.&rdquo;
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="number-name">Name</Label>
          <Input
            id="number-name"
            value={name}
            maxLength={64}
            placeholder="e.g. Alabama outbound"
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !pending) onSave();
            }}
          />
          <p className="text-muted-foreground text-xs">
            Leave blank to reset to the phone number.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={pending}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
