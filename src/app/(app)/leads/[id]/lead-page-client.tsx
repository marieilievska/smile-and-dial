"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { CallNowDialog } from "../call-now-dialog";
import {
  AutosaveField,
  CollapsibleSection,
  CONTACT_FIELDS,
  CustomFieldEditor,
  GOOGLE_FIELDS,
  InfoRow,
  LOCATION_FIELDS,
  STATUS_TEXT,
  formatDateTime,
  humanize,
  statusVariant,
  useLeadSaver,
  type CustomFieldDef,
  type LeadMeta,
  type StandardField,
} from "../lead-detail-parts";
import { MergeInboundDialog } from "../merge-inbound-dialog";

/** Three-zone interactive shell for /leads/<id>. Server component
 *  fetches the data; this component owns the autosave state and the
 *  collapsible sections. */
export function LeadPageClient({
  leadId,
  leadCompany,
  fieldValues,
  customFields,
  customValues,
  meta,
  availableCampaigns,
  activityFeed,
}: {
  leadId: string;
  leadCompany: string | null;
  fieldValues: Record<string, string>;
  customFields: CustomFieldDef[];
  customValues: Record<string, unknown>;
  meta: LeadMeta;
  availableCampaigns: { id: string; name: string }[];
  /** Rendered server-side; passed as children so this client component
   *  doesn't need to import the feed's data shape. */
  activityFeed: React.ReactNode;
}) {
  const { status, saveField, saveCustom } = useLeadSaver(leadId);

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
    <div className="flex flex-col gap-6 p-8">
      {/* Breadcrumb back to /leads — keeps the route navigable without
          hijacking the browser back button. */}
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-3">
          <Link href="/leads">
            <ArrowLeft className="size-4" />
            All leads
          </Link>
        </Button>
      </div>

      {/* HERO — company + status pill + Call Now. Three-zone layout
          starts below; the hero spans full width above. */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <h1 className="text-foreground text-2xl font-bold tracking-tight">
              {leadCompany || "Lead details"}
            </h1>
            <Badge variant={statusVariant(meta.status)} dot>
              {humanize(meta.status)}
            </Badge>
          </div>
          <p className="text-muted-foreground text-sm">{STATUS_TEXT[status]}</p>
        </div>
        <CallNowDialog
          leadId={leadId}
          availableCampaigns={availableCampaigns}
        />
      </div>

      {meta.isInbound ? (
        <div className="border-border bg-muted/30 flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
          <p className="text-muted-foreground text-sm">
            Auto-created from an inbound call. Merge into an existing lead if
            this caller already has a record.
          </p>
          <MergeInboundDialog sourceLeadId={leadId} />
        </div>
      ) : null}

      {/* Three-zone body — left (structured fields) | center (summary +
          at-a-glance) | right (activity feed). On smaller screens this
          stacks vertically. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(280px,1fr)_minmax(0,2fr)_minmax(280px,1.2fr)]">
        {/* LEFT — structured field sections, collapsible. Contact open
            by default. */}
        <div className="flex flex-col gap-3">
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
        </div>

        {/* CENTER — AI summary + at-a-glance + pipeline state. The
            summary is the hero so the operator sees the AI's read on
            the lead before deciding to call. */}
        <div className="flex flex-col gap-4">
          <section
            data-testid="ai-summary-block"
            className="border-border bg-muted/20 flex flex-col gap-2 rounded-lg border p-4"
          >
            <h2 className="text-foreground text-xs font-semibold tracking-wide uppercase">
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

          <dl className="grid grid-cols-2 gap-3 text-sm">
            <InfoRow label="List" value={meta.listName} />
            <InfoRow label="Last outcome" value={humanize(meta.lastOutcome)} />
            <InfoRow
              label="Next call"
              value={formatDateTime(meta.nextCallAt)}
            />
            <InfoRow
              label="Retry"
              value={meta.retryCounter > 0 ? `#${meta.retryCounter}` : "—"}
            />
            <InfoRow
              label="Resting until"
              value={formatDateTime(meta.restingUntil)}
            />
          </dl>
        </div>

        {/* RIGHT — activity feed. Chronological merge of calls +
            emails + system_events. Renders the React node passed in
            from the server component. */}
        <section
          data-testid="lead-activity-column"
          className="border-border bg-card flex flex-col gap-3 rounded-lg border p-4"
        >
          <h2 className="text-foreground text-sm font-semibold">Activity</h2>
          {activityFeed}
        </section>
      </div>
    </div>
  );
}
