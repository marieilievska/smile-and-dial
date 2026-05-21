"use client";

import { useRef, useState } from "react";
import { Clock } from "lucide-react";
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

/** Read-only pipeline context shown alongside the editable fields. */
export type LeadMeta = {
  status: string;
  lastOutcome: string | null;
  listName: string;
  retryCounter: number;
  restingUntil: string | null;
  nextCallAt: string | null;
  aiSummary: string | null;
};

/**
 * One entry in the lead's activity timeline. Today only the "created" event
 * exists; later phases append calls, callbacks, DNC changes, and edits.
 */
export type LeadEvent = {
  id: string;
  label: string;
  at: string;
};

function humanize(value: string | null): string {
  if (!value) return "—";
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ");
}

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

export function LeadDetailModal({
  leadId,
  leadCompany,
  fieldValues,
  customFields,
  customValues,
  meta,
  events,
}: {
  leadId: string;
  leadCompany: string | null;
  fieldValues: Record<string, string>;
  customFields: CustomFieldDef[];
  customValues: Record<string, unknown>;
  meta: LeadMeta;
  events: LeadEvent[];
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
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{leadCompany || "Lead details"}</DialogTitle>
          <DialogDescription>{STATUS_TEXT[status]}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
          <div className="flex flex-col gap-6">
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
              <Section title="Custom fields">
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
              </Section>
            ) : null}

            <Section title="AI summary">
              {meta.aiSummary ? (
                <p className="text-muted-foreground text-sm whitespace-pre-line">
                  {meta.aiSummary}
                </p>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No summary yet — this is generated after the lead is called.
                </p>
              )}
            </Section>

            <Section title="Campaign & list">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <InfoRow label="List" value={meta.listName} />
                <InfoRow label="Status" value={humanize(meta.status)} />
                <InfoRow
                  label="Last outcome"
                  value={humanize(meta.lastOutcome)}
                />
                <InfoRow
                  label="Retry counter"
                  value={String(meta.retryCounter)}
                />
                <InfoRow
                  label="Resting until"
                  value={formatDateTime(meta.restingUntil)}
                />
                <InfoRow
                  label="Next call"
                  value={formatDateTime(meta.nextCallAt)}
                />
              </dl>
            </Section>
          </div>

          <div className="lg:border-border lg:border-l lg:pl-6">
            <Section title="Activity">
              <ActivityTimeline events={events} />
            </Section>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A titled block inside the modal. */
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-foreground text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** A label/value pair in the read-only Campaign & list section. */
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}

/** The lead's activity timeline, newest first. */
function ActivityTimeline({ events }: { events: LeadEvent[] }) {
  if (events.length === 0) {
    return <p className="text-muted-foreground text-sm">No activity yet.</p>;
  }

  const ordered = [...events].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <ol className="flex flex-col gap-4">
      {ordered.map((event) => (
        <li key={event.id} className="flex gap-3">
          <span className="bg-muted text-muted-foreground mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full">
            <Clock className="size-3.5" />
          </span>
          <div className="flex flex-col">
            <span className="text-foreground text-sm font-medium">
              {event.label}
            </span>
            <span className="text-muted-foreground text-xs">
              {formatDateTime(event.at)}
            </span>
          </div>
        </li>
      ))}
    </ol>
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
