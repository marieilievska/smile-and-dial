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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createCustomFieldInline } from "@/lib/custom-fields/actions";

type FieldType = "text" | "number" | "date" | "boolean";

const TYPE_LABEL: Record<FieldType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  boolean: "Yes / No",
};

/** Dialog for creating a custom field while in the middle of mapping a
 *  CSV column to one. The Map step opens this when the user picks
 *  "+ Create as new custom field" from the column-mapping select.
 *
 *  On success the new field is registered under Settings → Custom
 *  fields *and* the parent wizard auto-selects it for the column the
 *  user was mapping. No round-trip through Settings required. */
export function CreateCustomFieldInlineDialog({
  open,
  initialName,
  onOpenChange,
  onCreated,
  onCancel,
}: {
  open: boolean;
  /** Defaults to the CSV header the user is mapping, so they don't
   *  have to retype it. */
  initialName: string;
  onOpenChange: (next: boolean) => void;
  /** Called with the new custom field id + name + type after a
   *  successful create. */
  onCreated: (id: string, name: string) => void;
  /** Called if the user dismisses without creating — the parent reverts
   *  the column's mapping back to whatever it was before. */
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [type, setType] = useState<FieldType>("text");
  const [pending, startTransition] = useTransition();

  // Reset to the new initial name whenever the dialog re-opens for a
  // different column. (Otherwise the previous column's name sticks.)
  // Tracking "last open initialName" instead of an effect avoids the
  // setState-in-effect lint trap — the state resets at render time
  // when the dialog (re)opens, which is exactly what we want.
  const [lastOpenedFor, setLastOpenedFor] = useState<string | null>(
    open ? initialName : null,
  );
  if (open && lastOpenedFor !== initialName) {
    setLastOpenedFor(initialName);
    setName(initialName);
    setType("text");
  } else if (!open && lastOpenedFor !== null) {
    setLastOpenedFor(null);
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    startTransition(async () => {
      const result = await createCustomFieldInline({ name: trimmed, type });
      if (result.error || !result.id) {
        toast.error(result.error ?? "Could not create the field.");
        return;
      }
      toast.success(
        `Custom field "${trimmed}" added — visible in Settings → Custom fields.`,
      );
      onCreated(result.id, trimmed);
      onOpenChange(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a new custom field</DialogTitle>
          <DialogDescription>
            Adds the field to Settings → Custom fields so you can use it on
            every lead from now on. The current import will map this column into
            it automatically.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="inline-field-name">Field name</Label>
            <Input
              id="inline-field-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Membership tier"
              autoFocus
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="inline-field-type">Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as FieldType)}>
              <SelectTrigger id="inline-field-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(TYPE_LABEL) as FieldType[]).map((key) => (
                  <SelectItem key={key} value={key}>
                    {TYPE_LABEL[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Multi-option (&ldquo;select&rdquo;) fields can be added later from
              Settings → Custom fields.
            </p>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? "Creating…" : "Create field"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
