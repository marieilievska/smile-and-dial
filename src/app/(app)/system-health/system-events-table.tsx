"use client";

import {
  ChevronDown,
  ChevronRight,
  Check,
  Copy,
  ExternalLink,
  Layers,
  List,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

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

function sevVariantFor(
  severity: Severity,
): "destructive" | "warning" | "secondary" {
  return severity === "error"
    ? "destructive"
    : severity === "warn"
      ? "warning"
      : "secondary";
}

function sevLabelFor(severity: Severity): string {
  return severity[0].toUpperCase() + severity.slice(1);
}

/** Table for the system_events list.
 *
 *  Flat mode (default) shows one expandable row per event. "Group
 *  similar" collapses events of the same kind into a single cluster
 *  row ("Dialer failure ×40 · latest 2m ago") that expands to its
 *  members — so a noisy incident reads as one line instead of a wall.
 *  Each row / member expands again to the pretty-printed payload with
 *  a Copy JSON button. */
export function SystemEventsTable({
  events,
  now,
}: {
  events: SystemEvent[];
  /** Server-passed `now` (ISO) for the relative-time render. */
  now: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [grouped, setGrouped] = useState(false);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const nowDate = new Date(now);

  // Cluster by kind, count-descending. Events arrive newest-first, so
  // members keep that order and the cluster's "latest" is its first.
  const clusters = useMemo(() => {
    const byKind = new Map<string, SystemEvent[]>();
    for (const e of events) {
      const list = byKind.get(e.kind);
      if (list) list.push(e);
      else byKind.set(e.kind, [e]);
    }
    return Array.from(byKind.entries())
      .map(([kind, members]) => ({ kind, members }))
      .sort((a, b) => b.members.length - a.members.length);
  }, [events]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">
          {grouped
            ? `${clusters.length.toLocaleString()} event ${clusters.length === 1 ? "kind" : "kinds"}`
            : `${events.length.toLocaleString()} ${events.length === 1 ? "event" : "events"}`}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setGrouped((g) => !g)}
          data-testid="group-similar-toggle"
          data-grouped={grouped ? "true" : "false"}
        >
          {grouped ? (
            <>
              <List className="size-3.5" />
              Show individually
            </>
          ) : (
            <>
              <Layers className="size-3.5" />
              Group similar
            </>
          )}
        </Button>
      </div>

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
              {grouped ? null : <TableHead>Reference</TableHead>}
              {grouped ? null : <TableHead>Actor</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {grouped
              ? clusters.map((c) => (
                  <ClusterRow
                    key={c.kind}
                    kind={c.kind}
                    members={c.members}
                    nowDate={nowDate}
                    isExpanded={expanded.has(`cluster:${c.kind}`)}
                    onToggle={() => toggle(`cluster:${c.kind}`)}
                  />
                ))
              : events.map((e) => (
                  <EventRow
                    key={e.id}
                    event={e}
                    whenLabel={formatEventWhen(e.created_at, nowDate)}
                    whenTooltip={new Date(e.created_at).toLocaleString()}
                    isExpanded={expanded.has(e.id)}
                    onToggle={() => toggle(e.id)}
                  />
                ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function ClusterRow({
  kind,
  members,
  nowDate,
  isExpanded,
  onToggle,
}: {
  kind: string;
  members: SystemEvent[];
  nowDate: Date;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const severity = members[0]?.severity ?? "info";
  const latest = members[0]?.created_at;
  const count = members.length;
  return (
    <>
      <TableRow
        className="hover:bg-muted/40 group cursor-pointer transition-colors"
        data-severity={severity}
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
            aria-label={isExpanded ? "Hide events" : "Show events"}
            className="text-muted-foreground hover:text-foreground hover:bg-muted/60 inline-flex size-6 items-center justify-center rounded-md transition-colors"
          >
            {isExpanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </button>
        </TableCell>
        <TableCell className="text-muted-foreground tabular-nums">
          {latest ? formatEventWhen(latest, nowDate) : "—"}
        </TableCell>
        <TableCell>
          <Badge variant={sevVariantFor(severity)} dot>
            {sevLabelFor(severity)}
          </Badge>
        </TableCell>
        <TableCell colSpan={3}>
          <div className="flex items-center gap-2">
            <span className="text-foreground font-medium">
              {humanizeKind(kind)}
            </span>
            <Badge variant="secondary" className="tabular-nums">
              ×{count.toLocaleString()}
            </Badge>
            <code className="text-muted-foreground/80 font-mono text-[10px]">
              {kind}
            </code>
          </div>
        </TableCell>
      </TableRow>
      {isExpanded ? (
        <TableRow className="bg-muted/30">
          <TableCell />
          <TableCell colSpan={5}>
            <ul className="flex flex-col gap-1 py-1">
              {members.map((m) => (
                <ClusterMember key={m.id} event={m} nowDate={nowDate} />
              ))}
            </ul>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function ClusterMember({
  event,
  nowDate,
}: {
  event: SystemEvent;
  nowDate: Date;
}) {
  const [open, setOpen] = useState(false);
  const refHref = refHrefFor(event.ref_table, event.ref_id);
  return (
    <li className="border-border/50 flex flex-col gap-1 border-b py-1.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          {open ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
          <span
            className="tabular-nums"
            title={new Date(event.created_at).toLocaleString()}
          >
            {formatEventWhen(event.created_at, nowDate)}
          </span>
        </button>
        {event.ref_table ? (
          <span className="text-muted-foreground inline-flex items-center gap-1">
            {refLabelFor(event.ref_table)}
            {refHref ? (
              <Link
                href={refHref}
                className="hover:text-foreground inline-flex items-center gap-1 font-mono text-[10px] underline-offset-4 hover:underline"
              >
                {(event.ref_id ?? "—").slice(0, 8)}
                <ExternalLink className="size-2.5" />
              </Link>
            ) : (
              <code className="font-mono text-[10px]">
                {(event.ref_id ?? "—").slice(0, 8)}
              </code>
            )}
          </span>
        ) : null}
        <span className="text-muted-foreground">
          {event.actor_name ?? (event.actor_user_id ? "—" : "system")}
        </span>
      </div>
      {open ? (
        <PayloadPanel payload={event.payload} eventId={event.id} />
      ) : null}
    </li>
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
          <Badge variant={sevVariantFor(event.severity)} dot>
            {sevLabelFor(event.severity)}
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
