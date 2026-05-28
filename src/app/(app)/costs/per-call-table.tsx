"use client";

import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { pickBreakdown, type CostsRow } from "@/lib/analytics/costs";

import { formatStartedAt } from "./format-time";

function usd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

function fmtDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

/** Per-call table for /costs. Round 20 — defaults to a 4-column
 *  compact view (Started · Campaign · Duration · Total) with the
 *  per-vendor breakdown tucked behind an expand chevron per row.
 *  Open link is sticky-right and hover-only so the table reads
 *  cleanly at rest.
 *
 *  All client-side: client component so the row-expand state can
 *  live in React without ferrying it through URL params. */
export function PerCallTable({
  rows,
  campaignName,
  now,
}: {
  rows: CostsRow[];
  campaignName: Map<string, string>;
  /** Server-passed `Date` so first-paint relative times match the
   *  SSR render and we don't see a hydration flash. */
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

  if (rows.length === 0) {
    return (
      <div className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
        <p className="text-foreground text-sm font-medium">
          No calls in this range
        </p>
        <p className="text-muted-foreground max-w-xs text-sm">
          Widen the date range or remove a filter to see individual call
          breakdowns.
        </p>
      </div>
    );
  }

  const nowDate = new Date(now);

  return (
    <div
      className="border-border overflow-hidden rounded-lg border"
      data-testid="per-call-table"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead>Started</TableHead>
            <TableHead>Campaign</TableHead>
            <TableHead className="text-right">Duration</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead className="bg-background sticky right-0 w-16 text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const b = pickBreakdown(r.cost_breakdown);
            const isExpanded = expanded.has(r.id);
            const startedIso = r.started_at ?? r.created_at;
            return (
              <RowFragment
                key={r.id}
                row={r}
                breakdown={b}
                campaignName={campaignName.get(r.campaign_id) ?? "—"}
                startedLabel={formatStartedAt(startedIso, nowDate)}
                startedTitle={new Date(startedIso).toLocaleString()}
                duration={fmtDuration(r.duration_seconds)}
                isExpanded={isExpanded}
                onToggle={() => toggle(r.id)}
              />
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function RowFragment({
  row,
  breakdown,
  campaignName,
  startedLabel,
  startedTitle,
  duration,
  isExpanded,
  onToggle,
}: {
  row: CostsRow;
  breakdown: ReturnType<typeof pickBreakdown>;
  campaignName: string;
  startedLabel: string;
  startedTitle: string;
  duration: string;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <TableRow className="group">
        <TableCell className="w-8 align-top">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={isExpanded}
            aria-label={
              isExpanded ? "Hide cost breakdown" : "Show cost breakdown"
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
          title={startedTitle}
        >
          {startedLabel}
        </TableCell>
        <TableCell className="text-foreground">{campaignName}</TableCell>
        <TableCell className="text-muted-foreground text-right tabular-nums">
          {duration}
        </TableCell>
        <TableCell className="text-foreground text-right font-medium tabular-nums">
          {usd(breakdown.total)}
        </TableCell>
        <TableCell
          className="bg-background sticky right-0 text-right"
          style={{
            backgroundColor:
              "color-mix(in oklab, var(--muted) 0%, var(--background))",
          }}
        >
          <div className="flex justify-end opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <Button asChild variant="ghost" size="sm">
              <Link
                href={`/calls?call=${row.id}`}
                aria-label="Open call detail"
              >
                <ExternalLink className="size-3.5" />
                Open
              </Link>
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {isExpanded ? (
        <TableRow data-testid="per-call-breakdown" className="bg-muted/30">
          <TableCell />
          <TableCell colSpan={5}>
            <ul className="text-muted-foreground grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
              <BreakdownItem label="Twilio" value={breakdown.twilio} />
              <BreakdownItem label="ElevenLabs" value={breakdown.elevenlabs} />
              <BreakdownItem label="OpenAI" value={breakdown.openai} />
              <BreakdownItem label="Twilio Lookup" value={breakdown.lookup} />
            </ul>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function BreakdownItem({ label, value }: { label: string; value: number }) {
  return (
    <li className="flex items-baseline justify-between gap-2">
      <span>{label}</span>
      <span className="text-foreground tabular-nums">{usd(value)}</span>
    </li>
  );
}
