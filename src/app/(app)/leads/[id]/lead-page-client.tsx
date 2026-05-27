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
  InfoRow,
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

/** Three-zone interactive shell for /leads/<id>. Server component
 *  fetches the data; this component owns the autosave state and the
 *  collapsible sections.
 *
 *  v2 refinements (D1–D7):
 *   D1+D2 — Hero shows company, status, phone, city/state, last-called
 *           snapshot, and a coral Call-now primary action.
 *   D3   — AI summary card lifted with a coral Sparkles icon + card
 *           surface so it reads as the page's main signal.
 *   D4   — Section labels renamed to user-side terms.
 *   D5   — On viewports < 1280px the activity feed collapses into a
 *           native <details> block under the AI summary instead of a
 *           narrow side column.
 *   D6   — "Since you last looked" chip above the activity feed,
 *           localStorage-driven (see SinceLastViewed).
 *   D7   — Autosave status moves out of the hero into a floating
 *           bottom-right chip that animates in/out. */
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
  /** Rendered server-side; passed as children so this client component
   *  doesn't need to import the feed's data shape. */
  activityFeed: React.ReactNode;
  /** Flat list of feed item timestamps + descriptions for the
   *  "since-you-last-looked" chip. Lighter than passing the whole
   *  FeedItem[] across the server/client boundary. */
  feedItemsForChip: { at: string; description: string }[];
}) {
  const { status, saveField, saveCustom } = useLeadSaver(leadId);
  const searchParams = useSearchParams();
  // D1+D2 deep-link: rows on /leads send users here with ?action=call
  // when they click the row's Call quick-action. We auto-open the
  // CallNowDialog once and then forget about it.
  const [callDialogOpen, setCallDialogOpen] = useState(false);
  useEffect(() => {
    if (searchParams.get("action") === "call") {
      // Reading a URL search param into local state on mount — the URL
      // is the external system here, not React state.
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
    <div className="flex flex-col gap-6 p-8">
      {/* Breadcrumb back to /leads */}
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-3">
          <Link href="/leads">
            <ArrowLeft className="size-4" />
            All leads
          </Link>
        </Button>
      </div>

      {/* D1+D2 — Hero. Identity left (company + status, then phone +
          city/state + last-called sub-line), action cluster right
          (Call now primary, then secondary actions). */}
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

      {/* Three-zone body — left (structured fields) | center (AI summary
          + at-a-glance) | right (activity feed at lg+, collapses into
          a <details> in the center column at smaller widths). */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(280px,1fr)_minmax(0,2fr)_minmax(280px,1.2fr)]">
        {/* LEFT — structured field sections. Basics open by default. */}
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
        </div>

        {/* CENTER — AI summary (D3) + at-a-glance facts. Activity feed
            collapses into a <details> here on screens below lg. */}
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

          {/* D5 — Activity surface on screens below lg. The lg side
              column stays the canonical surface; here we collapse it
              into a <details> so it doesn't crowd out the AI summary. */}
          <details
            className="border-border bg-card rounded-lg border lg:hidden"
            data-testid="activity-collapsible"
          >
            <summary className="hover:bg-muted/40 cursor-pointer list-none rounded-lg px-4 py-3 text-sm font-semibold">
              Activity
            </summary>
            <div className="flex flex-col gap-3 px-4 pt-1 pb-4">
              <SinceLastViewed leadId={leadId} items={feedItemsForChip} />
              {activityFeed}
            </div>
          </details>
        </div>

        {/* RIGHT — Activity column at lg+ only. */}
        <section
          data-testid="lead-activity-column"
          className="border-border bg-card hidden flex-col gap-3 rounded-lg border p-4 lg:flex"
        >
          <h2 className="text-foreground text-sm font-semibold">Activity</h2>
          <SinceLastViewed leadId={leadId} items={feedItemsForChip} />
          {activityFeed}
        </section>
      </div>

      {/* D7 — Autosave indicator. Floats in the bottom-right when
          actively saving or just-saved; absent otherwise. */}
      <AutosaveIndicator status={status} />
    </div>
  );
}

/** Tiny floating chip that telegraphs autosave state. Pinned bottom-
 *  right of the viewport, fades in while saving / saved, hidden when
 *  idle so the hero isn't paying a status-text tax. */
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

/** Render "Last contacted Nh ago" / "yesterday" / "Mar 4" / "never" for
 *  the hero sub-line. */
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
