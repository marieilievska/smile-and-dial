"use client";

import {
  ArrowLeft,
  Loader2,
  MapPin,
  Phone,
  Plus,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { CallNowDialog } from "../call-now-dialog";
import {
  AutosaveField,
  CollapsibleSection,
  CONTACT_FIELDS,
  CustomFieldEditor,
  GOOGLE_FIELDS,
  LOCATION_FIELDS,
  formatDateTime,
  humanize,
  statusVariant,
  useLeadSaver,
  type CustomFieldDef,
  type LeadMeta,
  type StandardField,
} from "../lead-detail-parts";
import { MergeInboundDialog } from "../merge-inbound-dialog";
import { SinceLastViewed } from "./since-last-viewed";

/** v3 — two-zone layout. Left column carries every field surface (all
 *  structured + custom + at-a-glance facts). Right column stacks the
 *  AI summary on top of the activity feed in the same column. Mirrors
 *  Close: identity + actions up top, fields left, AI + history right. */
export function LeadPageClient({
  leadId,
  leadCompany,
  fieldValues,
  customFields,
  customValues,
  meta,
  availableCampaigns,
  activityFeed,
  feedItemsForChip,
}: {
  leadId: string;
  leadCompany: string | null;
  fieldValues: Record<string, string>;
  customFields: CustomFieldDef[];
  customValues: Record<string, unknown>;
  meta: LeadMeta;
  availableCampaigns: { id: string; name: string }[];
  activityFeed: React.ReactNode;
  feedItemsForChip: { at: string; description: string }[];
}) {
  const { status, saveField, saveCustom } = useLeadSaver(leadId);
  const searchParams = useSearchParams();
  const [callDialogOpen, setCallDialogOpen] = useState(false);
  useEffect(() => {
    if (searchParams.get("action") === "call") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCallDialogOpen(true);
    }
  }, [searchParams]);

  function renderFields(fields: StandardField[]) {
    return (
      <div className="grid grid-cols-1 gap-4">
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
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-8">
      {/* Breadcrumb back to /leads */}
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-3">
          <Link href="/leads">
            <ArrowLeft className="size-4" />
            All leads
          </Link>
        </Button>
      </div>

      {/* Hero — identity left, action cluster right. */}
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-foreground text-3xl font-semibold tracking-tight">
              {leadCompany || "Lead details"}
            </h1>
            <Badge variant={statusVariant(meta.status)} dot>
              {humanize(meta.status)}
            </Badge>
          </div>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {meta.businessPhone ? (
              <a
                href={`tel:${meta.businessPhone}`}
                className="text-foreground inline-flex items-center gap-1.5 font-mono text-sm transition-colors hover:text-[color:var(--coral)]"
              >
                <Phone className="size-3.5" />
                {meta.businessPhone}
              </a>
            ) : null}
            {meta.city || meta.state ? (
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="size-3.5" />
                {[meta.city, meta.state].filter(Boolean).join(", ")}
              </span>
            ) : null}
            <span>Last contacted {lastContactedPhrase(meta.lastCallAt)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <CallNowDialog
            leadId={leadId}
            availableCampaigns={availableCampaigns}
            open={callDialogOpen}
            onOpenChange={setCallDialogOpen}
          />
          <Button variant="outline" size="sm" disabled title="Coming soon">
            <Plus className="size-4" />
            Note
          </Button>
        </div>
      </header>

      {meta.isInbound ? (
        <div className="border-border bg-muted/30 flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
          <p className="text-muted-foreground text-sm">
            Auto-created from an inbound call. Merge into an existing lead if
            this caller already has a record.
          </p>
          <MergeInboundDialog sourceLeadId={leadId} />
        </div>
      ) : null}

      {/* TWO-ZONE BODY
            LEFT  — every field + at-a-glance facts (collapsible blocks).
            RIGHT — AI summary on top, activity below in the same column. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        {/* LEFT */}
        <div className="flex flex-col gap-3">
          <CollapsibleSection title="Basics" defaultOpen>
            {renderFields(CONTACT_FIELDS)}
          </CollapsibleSection>
          <CollapsibleSection title="Address">
            {renderFields(LOCATION_FIELDS)}
          </CollapsibleSection>
          <CollapsibleSection title="Online presence">
            {renderFields(GOOGLE_FIELDS)}
          </CollapsibleSection>
          {customFields.length > 0 ? (
            <CollapsibleSection title="Custom fields">
              <div className="grid grid-cols-1 gap-4">
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

          {/* At-a-glance pipeline facts — moved into the left column
              under fields per the v3 layout. */}
          <CollapsibleSection title="Pipeline" defaultOpen>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <PipelineRow label="List" value={meta.listName} />
              <PipelineRow
                label="Last outcome"
                value={humanize(meta.lastOutcome)}
              />
              <PipelineRow
                label="Next call"
                value={formatDateTime(meta.nextCallAt)}
              />
              <PipelineRow
                label="Retry"
                value={meta.retryCounter > 0 ? `#${meta.retryCounter}` : "—"}
              />
              <PipelineRow
                label="Resting until"
                value={formatDateTime(meta.restingUntil)}
              />
            </dl>
          </CollapsibleSection>
        </div>

        {/* RIGHT — AI summary then activity, stacked. */}
        <div className="flex flex-col gap-4">
          <section
            data-testid="ai-summary-block"
            className="bg-card flex flex-col gap-3 rounded-xl border p-5"
            style={{
              borderColor:
                "color-mix(in oklab, var(--coral) 25%, var(--border))",
            }}
          >
            <h2 className="text-foreground inline-flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="size-4" style={{ color: "var(--coral)" }} />
              AI summary
            </h2>
            {meta.aiSummary ? (
              <p className="text-foreground text-sm leading-relaxed whitespace-pre-line">
                {meta.aiSummary}
              </p>
            ) : (
              <p className="text-muted-foreground text-sm">
                No summary yet — generated after the first call.
              </p>
            )}
          </section>

          <section
            data-testid="lead-activity-column"
            className="border-border bg-card flex flex-col gap-3 rounded-lg border p-4"
          >
            <h2 className="text-foreground text-sm font-semibold">Activity</h2>
            <SinceLastViewed leadId={leadId} items={feedItemsForChip} />
            {activityFeed}
          </section>
        </div>
      </div>

      <AutosaveIndicator status={status} />
    </div>
  );
}

/** Compact label/value pair for the Pipeline block. Tighter than the
 *  modal's old InfoRow — fits 2 columns at lg width comfortably. */
function PipelineRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-[10px] font-medium tracking-[0.1em] uppercase">
        {label}
      </dt>
      <dd className="text-foreground text-sm">{value}</dd>
    </div>
  );
}

/** Bottom-right floating chip with the autosave state. */
function AutosaveIndicator({
  status,
}: {
  status: "idle" | "saving" | "saved" | "error";
}) {
  if (status === "idle") return null;
  const text = {
    saving: "Saving…",
    saved: "Saved",
    error: "Couldn't save",
  }[status];
  const tone =
    status === "error"
      ? "border-destructive/40 text-destructive bg-destructive/5"
      : "border-border bg-card text-foreground";
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="autosave-indicator"
      data-state={status}
      className={`animate-in fade-in slide-in-from-bottom-1 fixed right-4 bottom-4 z-30 inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium shadow-sm ${tone}`}
    >
      {status === "saving" ? (
        <Loader2 className="text-muted-foreground size-3 animate-spin" />
      ) : null}
      {text}
    </div>
  );
}

function lastContactedPhrase(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  const now = Date.now();
  const min = Math.max(1, Math.floor((now - then) / 60000));
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 2) return "yesterday";
  if (day < 14) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}
