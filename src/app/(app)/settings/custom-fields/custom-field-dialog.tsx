"use client";

import { useState, useTransition } from "react";
import { Pencil, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  createCustomField,
  updateCustomField,
  type CustomFieldType,
} from "@/lib/custom-fields/actions";

export type CustomFieldData = {
  id: string;
  name: string;
  type: CustomFieldType;
  required: boolean;
  options: string[];
};

export function CustomFieldDialog({
  mode,
  field,
}: {
  mode: "create" | "edit";
  field?: CustomFieldData;
}) {
  const isEdit = mode === "edit";
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(field?.name ?? "");
  const [type, setType] = useState<CustomFieldType>(field?.type ?? "text");
  const [required, setRequired] = useState(field?.required ?? false);
  const [optionsText, setOptionsText] = useState(
    (field?.options ?? []).join("\n"),
  );

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const options = optionsText
      .split("\n")
      .map((option) => option.trim())
      .filter(Boolean);

    startTransition(async () => {
      try {
        const input = { name, type, required, options };
        const result =
          isEdit && field
            ? await updateCustomField(field.id, input)
            : await createCustomField(input);
        if (result.error) {
          toast.error(result.error);
        } else {
          toast.success(isEdit ? "Field updated." : "Field created.");
          setOpen(false);
          if (!isEdit) {
            setName("");
            setType("text");
            setRequired(false);
            setOptionsText("");
          }
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
            size="icon-sm"
            aria-label={`Edit ${field?.name ?? "field"}`}
          >
            <Pencil className="size-4" />
          </Button>
        ) : (
          <Button>
            <Plus className="size-4" />
            New field
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit custom field" : "New custom field"}
          </DialogTitle>
          <DialogDescription>
            Custom fields appear on every lead.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="field-name">Name</Label>
            <Input
              id="field-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="field-type">Type</Label>
            <Select
              value={type}
              onValueChange={(value) => setType(value as CustomFieldType)}
            >
              <SelectTrigger id="field-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="text">Text</SelectItem>
                <SelectItem value="number">Number</SelectItem>
                <SelectItem value="date">Date</SelectItem>
                <SelectItem value="boolean">Yes / No</SelectItem>
                <SelectItem value="select">Dropdown</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {type === "select" ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="field-options">Options (one per line)</Label>
              <Textarea
                id="field-options"
                value={optionsText}
                onChange={(event) => setOptionsText(event.target.value)}
                rows={4}
              />
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <Checkbox
              id="field-required"
              checked={required}
              onCheckedChange={(checked) => setRequired(checked === true)}
            />
            <Label htmlFor="field-required">Required field</Label>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : isEdit ? "Save changes" : "Create field"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
