"use client";

import { useRef, useState } from "react";
import { ChevronDown, Clock } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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

import { CallNowDialog } from "./call-now-dialog";
import { MergeInboundDialog } from "./merge-inbound-dialog";

type SaveResult = { error: string | null };
type SaveStatus = "idle" | "saving" | "saved" | "error";

type StandardField = { key: string; label: string; type: string };

/** Standard lead fields, grouped by how often the user actually touches
 *  them. Contact fields are open by default; Location & web and Google
 *  data are collapsed because most users don't edit them daily. */
const CONTACT_FIELDS: StandardField[] = [
  { key: "company", label: "Company", type: "text" },
  { key: "business_phone", label: "Business phone", type: "tel" },
  { key: "business_email", label: "Business email", type: "email" },
  { key: "owner_name", label: "Owner name", type: "text" },
  { key: "owner_phone", label: "Owner phone", type: "tel" },
  { key: "manager_name", label: "Manager name", type: "text" },
  { key: "employee_name", label: "Employee name", type: "text" },
];

const LOCATION_FIELDS: StandardField[] = [
  { key: "city", label: "City", type: "text" },
  { key: "state", label: "State", type: "text" },
  { key: "website", label: "Website", type: "url" },
  { key: "category", label: "Category", type: "text" },
];

const GOOGLE_FIELDS: StandardField[] = [
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
  /** True when the lead lives in the owner's system-managed Inbound list,
   *  meaning it was auto-created by the inbound webhook. Used to surface
   *  the "Merge into existing lead" button. */
  isInbound: boolean;
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

/** Map lead status to a Badge variant so the pill telegraphs urgency
 *  without needing to read the label. */
function statusVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "ready_to_call":
    case "callback":
    case "scheduled":
      return "default";
    case "goal_met":
    case "attended":
    case "sale":
    case "closed":
      return "secondary";
    case "dnc":
    case "no_show":
      return "destructive";
    default:
      return "outline";
  }
}

export function LeadDetailModal({
  leadId,
  leadCompany,
  fieldValues,
  customFields,
  customValues,
  meta,
  events,
  availableCampaigns,
}: {
  leadId: string;
  leadCompany: string | null;
  fieldValues: Record<string, string>;
  customFields: CustomFieldDef[];
  customValues: Record<string, unknown>;
  meta: LeadMeta;
  events: LeadEvent[];
  availableCampaigns: { id: string; name: string }[];
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

  function renderFields(fields: StandardField[]) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {fields.map((field) => (
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
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
        {/* HERO — company + status pill + Call Now. The most important
            facts and the most likely action sit at the very top. */}
        <DialogHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <DialogTitle>{leadCompany || "Lead details"}</DialogTitle>
                <Badge variant={statusVariant(meta.status)}>
                  {humanize(meta.status)}
                </Badge>
              </div>
              <DialogDescription>{STATUS_TEXT[status]}</DialogDescription>
            </div>
            <CallNowDialog
              leadId={leadId}
              availableCampaigns={availableCampaigns}
            />
          </div>
        </DialogHeader>

        {meta.isInbound ? (
          <div className="border-border bg-muted/30 flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <p className="text-muted-foreground text-sm">
              Auto-created from an inbound call. Merge into an existing lead if
              this caller already has a record.
            </p>
            <MergeInboundDialog sourceLeadId={leadId} />
          </div>
        ) : null}

        {/* AI SUMMARY — prominent because it's the one thing the user
            needs before deciding to call. */}
        <section
          data-testid="ai-summary-block"
          className="border-border bg-muted/20 flex flex-col gap-2 rounded-lg border p-3"
        >
          <h3 className="text-foreground text-xs font-semibold tracking-wide uppercase">
            AI summary
          </h3>
          {meta.aiSummary ? (
            <p className="text-foreground text-sm whitespace-pre-line">
              {meta.aiSummary}
            </p>
          ) : (
            <p className="text-muted-foreground text-sm">
              No summary yet — generated after the first call.
            </p>
          )}
        </section>

        {/* AT-A-GLANCE strip — same data as the old "Campaign & list"
            block but pulled up into one compact row. */}
        <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <InfoRow label="List" value={meta.listName} />
          <InfoRow label="Last outcome" value={humanize(meta.lastOutcome)} />
          <InfoRow label="Next call" value={formatDateTime(meta.nextCallAt)} />
          <InfoRow
            label="Retry"
            value={meta.retryCounter > 0 ? `#${meta.retryCounter}` : "—"}
          />
        </dl>

        {/* Collapsible detail sections. Contact is open by default; the
            rest are tucked away. */}
        <CollapsibleSection title="Contact" defaultOpen>
          {renderFields(CONTACT_FIELDS)}
        </CollapsibleSection>

        <CollapsibleSection title="Location & web">
          {renderFields(LOCATION_FIELDS)}
        </CollapsibleSection>

        <CollapsibleSection title="Google data">
          {renderFields(GOOGLE_FIELDS)}
        </CollapsibleSection>

        {customFields.length > 0 ? (
          <CollapsibleSection title="Custom fields">
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
          </CollapsibleSection>
        ) : null}

        <CollapsibleSection title="Pipeline state">
          <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <InfoRow
              label="Resting until"
              value={formatDateTime(meta.restingUntil)}
            />
            <InfoRow label="Retry counter" value={String(meta.retryCounter)} />
          </dl>
        </CollapsibleSection>

        <CollapsibleSection title="Activity">
          <ActivityTimeline events={events} />
        </CollapsibleSection>
      </DialogContent>
    </Dialog>
  );
}

/** Collapsible disclosure built on the native <details> element — no JS
 *  state, no library, fully keyboard- and screen-reader-friendly. */
function CollapsibleSection({
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

/** A label/value pair in the read-only at-a-glance strip. */
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
