"use client";

import { Loader2, Sparkles } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Breadcrumbs } from "@/components/app-shell/breadcrumbs";
import { Badge } from "@/components/ui/badge";

import { CallDetailModal } from "../../calls/call-detail-modal";
import { CallNowDialog } from "../call-now-dialog";
import {
  AutosaveField,
  CollapsibleSection,
  CONTACT_FIELDS,
  CustomFieldEditor,
  GOOGLE_FIELDS,
  LOCATION_FIELDS,
  statusVariant,
  useLeadSaver,
  type CustomFieldDef,
  type LeadMeta,
  type StandardField,
} from "../lead-detail-parts";
import { leadStatusLabel, outcomeLabel } from "@/lib/labels";
import {
  exactDateTime,
  relativeTime,
  relativeTimeSigned,
} from "@/lib/relative-time";
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
      {/* Round 36 (N3) — upgraded from a single "All leads" back
       *  button to a real breadcrumb trail. Reads as part of the
       *  site hierarchy ("Leads / Acme Co") rather than a one-shot
       *  back affordance, which matters because the lead detail is
       *  often linked to directly from notifications, the global
       *  search, and the Calls table. */}
      <Breadcrumbs
        items={[
          { label: "Leads", href: "/leads" },
          { label: leadCompany || "Lead" },
        ]}
      />

      {/* Hero — editable company name + status pill on the left,
          action cluster (Mark DNC, Delete, Call now) on the right.
          The destructive actions sit before Call now so the primary
          coral button retains the visual anchor at the trailing edge. */}
      <header className="animate-in fade-in slide-in-from-bottom-1 fill-mode-both flex flex-col gap-3 delay-75 duration-500 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
          <EditableCompanyName
            initial={leadCompany}
            onSave={saveField("company")}
          />
          <Badge variant={statusVariant(meta.status)} dot>
            {leadStatusLabel(meta.status)}
          </Badge>
          {meta.onCall ? <OnCallChip startedAt={meta.onCallStartedAt} /> : null}
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
        <div className="border-border bg-muted/30 animate-in fade-in slide-in-from-bottom-1 fill-mode-both flex items-center justify-between gap-3 rounded-lg border px-3 py-2 delay-100 duration-500">
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
        <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both flex flex-col gap-3 delay-150 duration-500">
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
                value={relativeTimeSigned(meta.nextCallAt)}
                title={exactDateTime(meta.nextCallAt)}
              />
              <PipelineRow
                label="Retry"
                value={meta.retryCounter > 0 ? `#${meta.retryCounter}` : "—"}
              />
              <PipelineRow
                label="Resting until"
                value={relativeTimeSigned(meta.restingUntil)}
                title={exactDateTime(meta.restingUntil)}
              />
            </dl>
          </CollapsibleSection>
        </div>

        {/* RIGHT — AI summary then activity, stacked. */}
        <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both flex flex-col gap-4 delay-200 duration-500">
          {/* AI summary — a tinted, gradient-washed panel so it reads as
              a generated artifact rather than a plain note field. A
              freshness line (proxied off the last call, since summaries
              are rolling and regenerate per call) reinforces that this is
              kept current by the AI. */}
          <section
            data-testid="ai-summary-block"
            className="relative overflow-hidden rounded-xl border p-5"
            style={{
              borderColor:
                "color-mix(in oklab, var(--primary) 25%, var(--border))",
              backgroundImage:
                "linear-gradient(135deg, color-mix(in oklab, var(--primary) 8%, var(--card)), var(--card) 60%)",
            }}
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-foreground inline-flex items-center gap-2 text-sm font-semibold">
                <Sparkles
                  className="size-4"
                  style={{ color: "var(--primary)" }}
                />
                AI summary
              </h2>
              {meta.aiSummary && meta.lastCallAt ? (
                <span
                  className="text-muted-foreground text-[11px]"
                  title={exactDateTime(meta.lastCallAt)}
                >
                  Updated {relativeTime(meta.lastCallAt)}
                </span>
              ) : null}
            </div>
            {meta.aiSummary ? (
              <p className="text-foreground mt-3 text-sm leading-relaxed whitespace-pre-line">
                {meta.aiSummary}
              </p>
            ) : (
              <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
                The AI will write a running summary here after its first call —
                what the contact said, where things stand, and what to do next.
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

/** Compact label/value pair for the Pipeline block. An optional `title`
 *  surfaces the exact timestamp on hover for the relative-time rows
 *  (Next call / Resting until). */
function PipelineRow({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-[10px] font-medium tracking-[0.1em] uppercase">
        {label}
      </dt>
      <dd className="text-foreground text-sm" title={title || undefined}>
        {value}
      </dd>
    </div>
  );
}

/** Live "On call now" pulse + elapsed timer shown in the hero while the
 *  dialer has a call in flight for this lead. The timer ticks client-side
 *  from the call's start time; before the call connects (no startedAt yet)
 *  we just show the pulse + label. Mirrors the leads-list on-call cue so
 *  the page you opened to watch a lead reflects that it's being called. */
function OnCallChip({ startedAt }: { startedAt: string | null }) {
  const [elapsed, setElapsed] = useState<string | null>(null);
  useEffect(() => {
    if (!startedAt) return;
    const start = new Date(startedAt).getTime();
    if (!Number.isFinite(start)) return;
    const tick = () => {
      const secs = Math.max(0, Math.floor((Date.now() - start) / 1000));
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      setElapsed(`${m}:${s.toString().padStart(2, "0")}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  return (
    <span
      data-testid="lead-on-call"
      className="text-primary inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
      style={{
        backgroundColor: "color-mix(in oklab, var(--primary) 12%, transparent)",
      }}
      title="On a call right now"
    >
      <span aria-hidden className="relative flex size-2">
        <span
          className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-70"
          style={{ backgroundColor: "var(--primary)" }}
        />
        <span
          className="relative inline-flex size-2 rounded-full"
          style={{ backgroundColor: "var(--primary)" }}
        />
      </span>
      On call now
      {elapsed ? (
        <span className="font-mono tabular-nums">{elapsed}</span>
      ) : null}
    </span>
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
