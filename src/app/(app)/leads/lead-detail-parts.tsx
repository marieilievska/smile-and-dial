"use client";

import { useRef, useState } from "react";
import { ChevronDown, Clock } from "lucide-react";
import { toast } from "sonner";

import { Checkbox } from "@/components/ui/checkbox";
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
  setLeadDecisionMakerReached,
  updateLeadCustomValue,
  updateLeadField,
} from "@/lib/leads/lead-actions";
import { leadStatusBadgeVariant } from "@/lib/outcome-style";

/** Helpers shared by the lead detail modal and the full /leads/[id]
 *  route. Anything that touches lead field state or save lifecycle
 *  lives here so the two surfaces never drift out of sync. */

export type SaveResult = { error: string | null };
export type SaveStatus = "idle" | "saving" | "saved" | "error";

export type StandardField = { key: string; label: string; type: string };

/** Standard lead fields grouped by edit frequency. Contact = most-edited;
 *  Location and Google are reference data that rarely changes. */
/** Company name is shown (and edited inline) in the hero, so it's
 *  intentionally not in CONTACT_FIELDS — that would be redundant. */
export const CONTACT_FIELDS: StandardField[] = [
  { key: "business_phone", label: "Business phone", type: "tel" },
  { key: "business_email", label: "Business email", type: "email" },
  { key: "owner_name", label: "Owner name", type: "text" },
  { key: "owner_phone", label: "Owner phone", type: "tel" },
  { key: "manager_name", label: "Manager name", type: "text" },
  { key: "employee_name", label: "Employee name", type: "text" },
];

export const LOCATION_FIELDS: StandardField[] = [
  { key: "city", label: "City", type: "text" },
  { key: "state", label: "State", type: "text" },
  { key: "website", label: "Website", type: "url" },
  { key: "category", label: "Category", type: "text" },
];

export const GOOGLE_FIELDS: StandardField[] = [
  { key: "google_place_id", label: "Google place ID", type: "text" },
  { key: "google_rating", label: "Google rating", type: "number" },
  { key: "google_reviews", label: "Google reviews", type: "number" },
];

export const STATUS_TEXT: Record<SaveStatus, string> = {
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

export type LeadMeta = {
  status: string;
  listName: string;
  isInbound: boolean;
  retryCounter: number;
  restingUntil: string | null;
  nextCallAt: string | null;
  /** ISO timestamp of the lead's most recent call, used by the hero
   *  to surface "Last contacted Nh ago" without needing to query the
   *  activity feed first. */
  lastCallAt: string | null;
  /** Surfaced in the hero so the operator can read/copy the phone
   *  without scrolling into the Contact section. */
  businessPhone: string | null;
  city: string | null;
  state: string | null;
  /** IANA timezone (e.g. "America/Chicago"), derived from the lead's state
   *  at import. Drives calling-hours; surfaced so the operator can see when
   *  it's the lead's daytime. */
  timezone: string | null;
  aiSummary: string | null;
  /** Sticky "have we ever reached the decision maker?" flag. Maintained by the
   *  post-call webhook, manually correctable on the detail page. */
  decisionMakerReached: boolean;
  /** True when the dialer has a call in flight for this lead right now —
   *  drives the live "On call now" pulse in the hero. */
  onCall: boolean;
  /** ISO start time of that in-flight call, so the hero can tick a live
   *  elapsed timer. Null when not on a call (or not yet connected). */
  onCallStartedAt: string | null;
};

export type LeadEvent = {
  id: string;
  label: string;
  at: string;
};

export function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

/** Lead-status Badge variant. Re-exported from the shared color module
 *  (`@/lib/outcome-style`) under the historical name so the lead detail
 *  page keeps importing it from here; the pill reads identically on the
 *  list, detail page, and goals pipeline. */
export const statusVariant = leadStatusBadgeVariant;

/** Wraps a save call so the surrounding component can show a single
 *  saving/saved/error status. */
export function useLeadSaver(leadId: string) {
  const [status, setStatus] = useState<SaveStatus>("idle");

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

  return { status, saveField, saveCustom };
}

/** Collapsible disclosure built on the native <details> element — no JS
 *  state, no library, fully keyboard- and screen-reader-friendly. */
export function CollapsibleSection({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      data-testid={`lead-section-${title.toLowerCase().replace(/\s+/g, "-")}`}
      className="border-border group rounded-lg border"
    >
      <summary className="hover:bg-muted/50 flex cursor-pointer list-none items-center justify-between rounded-lg px-3 py-2 transition-colors">
        <span className="text-foreground text-sm font-semibold">{title}</span>
        <ChevronDown className="text-muted-foreground size-4 transition-transform group-open:rotate-180" />
      </summary>
      <div className="px-3 pt-3 pb-4">{children}</div>
    </details>
  );
}

/** A label/value pair in read-only strips. */
export function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}

/** The lead's activity timeline, newest first. (Legacy — kept for the
 *  modal. The full route uses LeadActivityFeed which merges multiple
 *  sources.) */
export function ActivityTimeline({ events }: { events: LeadEvent[] }) {
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
export function AutosaveField({
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

/** Manually correctable "decision maker reached?" control. A two-state Yes/No
 *  segmented toggle that writes through to the lead immediately (optimistic,
 *  reverts on error). Lets an operator fix the AI's read when it was wrong. */
export function DecisionMakerToggle({
  leadId,
  initial,
}: {
  leadId: string;
  initial: boolean;
}) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);

  function set(next: boolean) {
    if (next === value || saving) return;
    const prev = value;
    setValue(next);
    setSaving(true);
    setLeadDecisionMakerReached({ leadId, value: next })
      .then((result) => {
        if (result.error) {
          setValue(prev);
          toast.error(result.error);
        }
      })
      .finally(() => setSaving(false));
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label>Decision maker reached</Label>
      <div className="border-border bg-muted/40 inline-flex w-fit rounded-md border p-0.5">
        {[
          { label: "Yes", on: true },
          { label: "No", on: false },
        ].map((opt) => {
          const active = value === opt.on;
          return (
            <button
              key={opt.label}
              type="button"
              aria-pressed={active}
              disabled={saving}
              onClick={() => set(opt.on)}
              className={`rounded px-3 py-1 text-sm font-medium transition-colors disabled:opacity-60 ${
                active
                  ? opt.on
                    ? "bg-emerald-500 text-white"
                    : "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Renders the right editor for a custom field's type. */
export function CustomFieldEditor({
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
