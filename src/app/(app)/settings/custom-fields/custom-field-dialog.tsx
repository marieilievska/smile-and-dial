"use client";

import {
  AlignLeft,
  Calendar,
  ChevronDown,
  Hash,
  List,
  Pencil,
  Plus,
  SlidersHorizontal,
  ToggleLeft,
  Type,
} from "lucide-react";
import { useState, useTransition } from "react";
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

import { DialogSection } from "../dialog-section";

export type CustomFieldData = {
  id: string;
  name: string;
  type: CustomFieldType;
  required: boolean;
  options: string[];
};

/** Per-type helper text so the dropdown isn't a guessing game. */
const TYPE_META: Record<
  CustomFieldType,
  { label: string; icon: React.ReactNode; helper: string }
> = {
  text: {
    label: "Text",
    icon: <Type className="size-3.5" />,
    helper: "Free-form text. Best for names, short notes, IDs.",
  },
  number: {
    label: "Number",
    icon: <Hash className="size-3.5" />,
    helper: "Numeric input. Used when you want to sort or filter by amount.",
  },
  date: {
    label: "Date",
    icon: <Calendar className="size-3.5" />,
    helper: "Date picker. Useful for renewal dates, deadlines, anniversaries.",
  },
  boolean: {
    label: "Yes / No",
    icon: <ToggleLeft className="size-3.5" />,
    helper: "A checkbox-style flag — only two possible values.",
  },
  select: {
    label: "Dropdown",
    icon: <List className="size-3.5" />,
    helper: "A picklist with the options you define below.",
  },
};

/** Slug preview — same logic as the server-side slugifier so the
 *  user sees what API key the field will get. Kept simple: lowercase,
 *  replace non-alphanumerics with `_`, trim runs. */
function previewSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

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

  const slugPreview = previewSlug(name);
  const optionsList = optionsText
    .split("\n")
    .map((option) => option.trim())
    .filter(Boolean);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      try {
        const input = { name, type, required, options: optionsList };
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

  const typeMeta = TYPE_META[type];

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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit custom field" : "New custom field"}
          </DialogTitle>
          <DialogDescription>
            Custom fields appear on every lead in the workspace and can be
            mapped during CSV imports.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <DialogSection
            icon={<SlidersHorizontal className="size-3.5" />}
            title="Name"
            description="Shown on lead detail pages. The slug is auto-generated for API use."
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="field-name">Name</Label>
              <Input
                id="field-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Tier, Renewal date, Notes"
                required
              />
              {name.trim() ? (
                <p className="text-muted-foreground text-xs">
                  Saved as{" "}
                  <code className="bg-muted rounded px-1 py-0.5 font-mono">
                    {slugPreview || "(invalid)"}
                  </code>
                </p>
              ) : null}
            </div>
          </DialogSection>

          <DialogSection
            icon={typeMeta.icon}
            title="Type"
            description={typeMeta.helper}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="field-type">Type</Label>
              <Select
                value={type}
                onValueChange={(value) => setType(value as CustomFieldType)}
              >
                <SelectTrigger id="field-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(TYPE_META) as CustomFieldType[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {TYPE_META[k].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </DialogSection>

          {type === "select" ? (
            <DialogSection
              icon={<ChevronDown className="size-3.5" />}
              title="Options"
              description="One option per line. These become the values in the dropdown on every lead."
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="field-options">Options</Label>
                <Textarea
                  id="field-options"
                  value={optionsText}
                  onChange={(event) => setOptionsText(event.target.value)}
                  rows={4}
                  placeholder={"Gold\nSilver\nBronze"}
                />
                {optionsList.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {optionsList.map((opt) => (
                      <span
                        key={opt}
                        className="border-border bg-muted/60 rounded-full border px-2 py-0.5 text-[11px]"
                      >
                        {opt}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </DialogSection>
          ) : null}

          <DialogSection
            icon={<AlignLeft className="size-3.5" />}
            title="Required"
            description="Required fields must be filled in before a lead can be saved or imported."
          >
            <label className="text-foreground inline-flex cursor-pointer items-center gap-2 text-sm select-none">
              <Checkbox
                id="field-required"
                checked={required}
                onCheckedChange={(checked) => setRequired(checked === true)}
              />
              Required field
            </label>
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
              {pending ? "Saving…" : isEdit ? "Save changes" : "Create field"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
