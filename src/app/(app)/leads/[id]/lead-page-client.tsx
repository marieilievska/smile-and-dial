"use client";

import { ArrowLeft, Loader2, Sparkles } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { CallDetailModal } from "../../calls/call-detail-modal";
import { CallNowDialog } from "../call-now-dialog";
import {
  AutosaveField,
  CollapsibleSection,
  CONTACT_FIELDS,
  CustomFieldEditor,
  GOOGLE_FIELDS,
  LOCATION_FIELDS,
  formatDateTime,
  statusVariant,
  useLeadSaver,
  type CustomFieldDef,
  type LeadMeta,
  type StandardField,
} from "../lead-detail-parts";
import { leadStatusLabel, outcomeLabel } from "@/lib/labels";
import { MergeInboundDialog } from "../merge-inbound-dialog";
import { EditableCompanyName } from "./editable-company-name";
import { LeadHeroActions } from "./lead-hero-actions";
import { SinceLastViewed } from "./since-last-viewed";

/** v3 — two-zone layout. Left = every field surface + at-a-glance.
 *  Right = AI summary stacked above the activity feed. The hero shows
 *  the company name (inline-editable) + status pill + Call now;
 *  redundant phone/city/last-call lines are dropped since the form
 *  fields below carry that information already. */
export function LeadPageClient({
  leadId,
  leadCompany,
  fieldValues,
  customFields,
  customValues,
  meta,
  availableCampaigns,
  activeCampaignId,
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
  activeCampaignId?: string;
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

      {/* Hero — editable company name + status pill on the left,
          action cluster (Mark DNC, Delete, Call now) on the right.
          The destructive actions sit before Call now so the primary
          coral button retains the visual anchor at the trailing edge. */}
      <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
          <EditableCompanyName
            initial={leadCompany}
            onSave={saveField("company")}
          />
          <Badge variant={statusVariant(meta.status)} dot>
            {leadStatusLabel(meta.status)}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <LeadHeroActions leadId={leadId} leadName={leadCompany} />
          <CallNowDialog
            leadId={leadId}
            availableCampaigns={availableCampaigns}
            initialCampaignId={activeCampaignId}
            open={callDialogOpen}
            onOpenChange={setCallDialogOpen}
          />
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

      {/* TWO-ZONE BODY — left column is narrower (form fields don't
            need much width); right column gets the bulk for the AI
            summary and activity feed where every extra inch helps. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
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

          <CollapsibleSection title="Pipeline" defaultOpen>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <PipelineRow label="List" value={meta.listName} />
              <PipelineRow
                label="Last outcome"
                value={outcomeLabel(meta.lastOutcome)}
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
      {/* Round 13 — the call detail modal is mounted here so clicking
          a call in the activity feed opens the audio + transcript
          inline, without navigating away from the lead detail. The
          modal reads ?call=<id> from the URL; its close handler
          (updated round 13) returns to the current pathname. */}
      <CallDetailModal />
    </div>
  );
}

/** Compact label/value pair for the Pipeline block. */
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
