"use client";

import { useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { type CustomFieldType } from "@/lib/custom-fields/actions";
import {
  updateLeadCustomValue,
  updateLeadField,
} from "@/lib/leads/lead-actions";

type SaveResult = { error: string | null };
type SaveStatus = "idle" | "saving" | "saved" | "error";

/** Standard lead fields shown in the modal, with their input type. */
const STANDARD_FIELDS: { key: string; label: string; type: string }[] = [
  { key: "company", label: "Company", type: "text" },
  { key: "business_phone", label: "Business phone", type: "tel" },
  { key: "business_email", label: "Business email", type: "email" },
  { key: "owner_name", label: "Owner name", type: "text" },
  { key: "owner_phone", label: "Owner phone", type: "tel" },
  { key: "manager_name", label: "Manager name", type: "text" },
  { key: "employee_name", label: "Employee name", type: "text" },
  { key: "website", label: "Website", type: "url" },
  { key: "category", label: "Category", type: "text" },
  { key: "city", label: "City", type: "text" },
  { key: "state", label: "State", type: "text" },
  { key: "google_place_id", label: "Google place ID", type: "text" },
  { key: "google_rating", label: "Google rating", type: "number" },
  { key: "google_reviews", label: "Google reviews", type: "number" },
];

const STATUS_TEXT: Record<SaveStatus, string> = {
  idle: "Changes save automatically.",
  saving: "Saving…",
  saved: "Saved",
  error: "Couldn't save — try again.",
};

export type CustomFieldDef = {
  id: string;
  name: string;
  type: CustomFieldType;
  options: string[];
};

export function LeadDetailModal({
  leadId,
  leadCompany,
  fieldValues,
  customFields,
  customValues,
}: {
  leadId: string;
  leadCompany: string | null;
  fieldValues: Record<string, string>;
  customFields: CustomFieldDef[];
  customValues: Record<string, unknown>;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<SaveStatus>("idle");

  function close() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("lead");
    const qs = params.toString();
    router.push(qs ? `/leads?${qs}` : "/leads");
  }

  /** Wrap a save call so the modal shows a single saving/saved status. */
  async function persist(run: () => Promise<SaveResult>): Promise<SaveResult> {
    setStatus("saving");
    const result = await run();
    if (result.error) {
      setStatus("error");
      toast.error(result.error);
    } else {
      setStatus("saved");
    }
    return result;
  }

  const saveField = (field: string) => (value: string) =>
    persist(() => updateLeadField({ leadId, field, value }));

  const saveCustom = (customFieldId: string) => (value: string | boolean) =>
    persist(() => updateLeadCustomValue({ leadId, customFieldId, value }));

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{leadCompany || "Lead details"}</DialogTitle>
          <DialogDescription>{STATUS_TEXT[status]}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {STANDARD_FIELDS.map((field) => (
            <AutosaveField
              key={field.key}
              id={`lead-${field.key}`}
              label={field.label}
              type={field.type}
              initial={fieldValues[field.key] ?? ""}
              onSave={saveField(field.key)}
            />
          ))}
        </div>

        {customFields.length > 0 ? (
          <div className="mt-2 flex flex-col gap-4">
            <h3 className="text-foreground text-sm font-semibold">
              Custom fields
            </h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {customFields.map((field) => (
                <CustomFieldEditor
                  key={field.id}
                  field={field}
                  initial={customValues[field.id]}
                  onSave={saveCustom(field.id)}
                />
              ))}
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** A text/number/date input that saves itself when it loses focus. */
function AutosaveField({
  id,
  label,
  type,
  initial,
  onSave,
}: {
  id: string;
  label: string;
  type: string;
  initial: string;
  onSave: (value: string) => Promise<SaveResult>;
}) {
  const [value, setValue] = useState(initial);
  const saved = useRef(initial);

  function commit() {
    if (value === saved.current) return;
    const next = value;
    onSave(next).then((result) => {
      if (result.error) setValue(saved.current);
      else saved.current = next;
    });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
      />
    </div>
  );
}

/** Renders the right editor for a custom field's type. */
function CustomFieldEditor({
  field,
  initial,
  onSave,
}: {
  field: CustomFieldDef;
  initial: unknown;
  onSave: (value: string | boolean) => Promise<SaveResult>;
}) {
  const id = `custom-${field.id}`;

  if (field.type === "boolean") {
    return (
      <BooleanField
        id={id}
        label={field.name}
        initial={initial === true}
        onSave={onSave}
      />
    );
  }

  if (field.type === "select") {
    return (
      <SelectField
        id={id}
        label={field.name}
        options={field.options}
        initial={initial == null ? "" : String(initial)}
        onSave={onSave}
      />
    );
  }

  const inputType =
    field.type === "number"
      ? "number"
      : field.type === "date"
        ? "date"
        : "text";
  return (
    <AutosaveField
      id={id}
      label={field.name}
      type={inputType}
      initial={initial == null ? "" : String(initial)}
      onSave={onSave}
    />
  );
}

/** A yes/no custom field that saves the moment it is toggled. */
function BooleanField({
  id,
  label,
  initial,
  onSave,
}: {
  id: string;
  label: string;
  initial: boolean;
  onSave: (value: boolean) => Promise<SaveResult>;
}) {
  const [checked, setChecked] = useState(initial);

  return (
    <div className="flex items-center gap-2 self-end pb-2">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(next) => {
          const value = next === true;
          setChecked(value);
          onSave(value).then((result) => {
            if (result.error) setChecked(initial);
          });
        }}
      />
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
    </div>
  );
}

/** A dropdown custom field that saves the moment a choice is made. */
function SelectField({
  id,
  label,
  options,
  initial,
  onSave,
}: {
  id: string;
  label: string;
  options: string[];
  initial: string;
  onSave: (value: string) => Promise<SaveResult>;
}) {
  const [value, setValue] = useState(initial);

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value}
        onValueChange={(next) => {
          setValue(next);
          onSave(next).then((result) => {
            if (result.error) setValue(initial);
          });
        }}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder="Choose…" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
