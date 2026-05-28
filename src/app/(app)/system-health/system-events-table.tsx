"use client";

import {
  ChevronDown,
  ChevronRight,
  Check,
  Copy,
  ExternalLink,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { formatEventWhen } from "./format-when";
import { humanizeKind } from "./humanize-kind";
import { refHrefFor, refLabelFor } from "./ref-link";

export type Severity = "info" | "warn" | "error";

export type SystemEvent = {
  id: string;
  kind: string;
  severity: Severity;
  actor_user_id: string | null;
  actor_name: string | null;
  ref_table: string | null;
  ref_id: string | null;
  payload: unknown;
  created_at: string;
};

/** Table for the system_events list. Round 22 — replaces the
 *  always-truncated single-line table with an expandable row pattern:
 *
 *  - Each row click toggles an expanded panel beneath it that shows
 *    the full pretty-printed payload + a "Copy JSON" button.
 *  - The Kind column shows the humanized label + raw snake_case
 *    underneath, so admins can scan AND copy.
 *  - Ref column links to the underlying object when the ref_table is
 *    known.
 *  - "When" humanizes to "2m ago" / "Yesterday" / "May 12" with the
 *    absolute timestamp on hover. */
export function SystemEventsTable({
  events,
  now,
}: {
  events: SystemEvent[];
  /** Server-passed `now` (ISO) for the relative-time render. */
  now: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const nowDate = new Date(now);

  return (
    <div
      data-testid="system-events-table"
      className="border-border overflow-hidden rounded-lg border"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead className="w-32">When</TableHead>
            <TableHead className="w-28">Severity</TableHead>
            <TableHead>Event</TableHead>
            <TableHead>Reference</TableHead>
            <TableHead>Actor</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((e) => {
            const isExpanded = expanded.has(e.id);
            return (
              <EventRow
                key={e.id}
                event={e}
                whenLabel={formatEventWhen(e.created_at, nowDate)}
                whenTooltip={new Date(e.created_at).toLocaleString()}
                isExpanded={isExpanded}
                onToggle={() => toggle(e.id)}
              />
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function EventRow({
  event,
  whenLabel,
  whenTooltip,
  isExpanded,
  onToggle,
}: {
  event: SystemEvent;
  whenLabel: string;
  whenTooltip: string;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const refHref = refHrefFor(event.ref_table, event.ref_id);
  const sevVariant: "destructive" | "warning" | "secondary" =
    event.severity === "error"
      ? "destructive"
      : event.severity === "warn"
        ? "warning"
        : "secondary";
  const sevLabel = event.severity[0].toUpperCase() + event.severity.slice(1);
  return (
    <>
      <TableRow
        className="hover:bg-muted/40 group cursor-pointer transition-colors"
        data-severity={event.severity}
        onClick={onToggle}
      >
        <TableCell className="w-8 align-middle">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            aria-expanded={isExpanded}
            aria-label={
              isExpanded ? "Hide event payload" : "Show event payload"
            }
            className="text-muted-foreground hover:text-foreground hover:bg-muted/60 inline-flex size-6 items-center justify-center rounded-md transition-colors"
          >
            {isExpanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </button>
        </TableCell>
        <TableCell
          className="text-muted-foreground tabular-nums"
          title={whenTooltip}
        >
          {whenLabel}
        </TableCell>
        <TableCell>
          <Badge variant={sevVariant} dot>
            {sevLabel}
          </Badge>
        </TableCell>
        <TableCell>
          <div className="flex flex-col gap-0.5">
            <span className="text-foreground font-medium">
              {humanizeKind(event.kind)}
            </span>
            <code className="text-muted-foreground/80 font-mono text-[10px]">
              {event.kind}
            </code>
          </div>
        </TableCell>
        <TableCell>
          {event.ref_table ? (
            <div className="flex flex-col gap-0.5">
              <span className="text-foreground text-xs">
                {refLabelFor(event.ref_table)}
              </span>
              {refHref ? (
                <Link
                  href={refHref}
                  onClick={(e) => e.stopPropagation()}
                  className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 font-mono text-[10px] underline-offset-4 hover:underline"
                >
                  {(event.ref_id ?? "—").slice(0, 8)}
                  <ExternalLink className="size-2.5" />
                </Link>
              ) : (
                <code className="text-muted-foreground font-mono text-[10px]">
                  {(event.ref_id ?? "—").slice(0, 8)}
                </code>
              )}
            </div>
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          )}
        </TableCell>
        <TableCell className="text-muted-foreground text-xs">
          {event.actor_name ?? (event.actor_user_id ? "—" : "system")}
        </TableCell>
      </TableRow>
      {isExpanded ? (
        <TableRow data-testid="event-payload" className="bg-muted/30">
          <TableCell />
          <TableCell colSpan={5}>
            <PayloadPanel payload={event.payload} eventId={event.id} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function PayloadPanel({
  payload,
  eventId,
}: {
  payload: unknown;
  eventId: string;
}) {
  const [copied, setCopied] = useState(false);
  const pretty =
    payload == null
      ? "{}"
      : (() => {
          try {
            return JSON.stringify(payload, null, 2);
          } catch {
            return String(payload);
          }
        })();

  async function copy() {
    try {
      await navigator.clipboard.writeText(pretty);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail in non-secure contexts; ignore.
    }
  }

  return (
    <div className="flex flex-col gap-2 py-2">
      <div className="text-muted-foreground flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold tracking-[0.16em] uppercase">
          Payload ·{" "}
          <code className="font-mono normal-case">{eventId.slice(0, 8)}</code>
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={copy}
          aria-label={copied ? "Copied payload" : "Copy payload as JSON"}
        >
          {copied ? (
            <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <Copy className="size-3.5" />
          )}
          {copied ? "Copied" : "Copy JSON"}
        </Button>
      </div>
      <pre className="border-border bg-card max-h-72 overflow-auto rounded-md border p-3 font-mono text-[11px] leading-relaxed">
        {pretty}
      </pre>
    </div>
  );
}
