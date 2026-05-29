"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { formatPhone } from "@/lib/format-phone";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { formatSince } from "./format-since";
import { GoalStatusActions, ViewOriginalCallLink } from "./goal-status-actions";
import type { PipelineLead } from "./pipeline-types";
import { GOAL_STATUS_LABELS, goalStatusVariant } from "./status-variant";

/** Pipeline rendered as a flat table (no per-campaign sections — those
 *  belong in the filter popover now). Each row links to the lead;
 *  middle-click opens a new tab.
 *
 *  Sticky-right actions cell follows the same pattern as calls /
 *  callbacks — bg-background + color-mix hover so the row tints
 *  uniformly. */
export function PipelineTable({ leads }: { leads: PipelineLead[] }) {
  const router = useRouter();
  const now = new Date();

  function openLead(leadId: string) {
    router.push(`/leads/${leadId}`);
  }

  return (
    <div className="border-border overflow-x-auto rounded-lg border">
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[34%] min-w-[260px]">Lead</TableHead>
            <TableHead className="w-[140px]">Status</TableHead>
            <TableHead className="w-[160px]">Goal · Campaign</TableHead>
            <TableHead className="w-[150px]">Goal met</TableHead>
            <TableHead className="w-[110px]">Original call</TableHead>
            <TableHead
              className="bg-background sticky right-0 z-10 w-[270px] shadow-[-8px_0_16px_-8px_rgba(0,0,0,0.06)]"
              aria-label="Row actions"
            />
          </TableRow>
        </TableHeader>
        <TableBody>
          {leads.map((lead) => {
            const since = formatSince(lead.goalMetAt, now);
            return (
              <TableRow
                key={lead.id}
                onClick={(event) => {
                  const target = event.target as HTMLElement;
                  if (target.closest("a, button")) return;
                  openLead(lead.id);
                }}
                onMouseDown={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    window.open(`/leads/${lead.id}`, "_blank", "noopener");
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") openLead(lead.id);
                }}
                tabIndex={0}
                className="group hover:bg-muted/50 cursor-pointer"
              >
                <TableCell className="w-[34%] min-w-[260px]">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <Link
                        href={`/leads/${lead.id}`}
                        className="text-foreground hover:text-primary truncate text-sm font-medium underline-offset-2 hover:underline"
                      >
                        {lead.company || "Unknown lead"}
                      </Link>
                      {since?.stale ? (
                        <span
                          className="inline-flex items-center rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400"
                          title="Sitting in the pipeline without progress for 2+ weeks — worth a nudge"
                        >
                          Stale{since.staleFor ? ` · ${since.staleFor}` : ""}
                        </span>
                      ) : null}
                    </div>
                    {lead.business_phone ? (
                      <span className="text-muted-foreground truncate font-mono text-[11px]">
                        {formatPhone(lead.business_phone)}
                      </span>
                    ) : null}
                  </div>
                </TableCell>

                <TableCell className="w-[140px]">
                  <Badge variant={goalStatusVariant(lead.status)} dot>
                    {GOAL_STATUS_LABELS[lead.status]}
                  </Badge>
                </TableCell>

                <TableCell className="w-[160px]">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-foreground truncate text-xs font-medium">
                      {lead.goal_name}
                    </span>
                    <span className="text-muted-foreground truncate text-[11px]">
                      {lead.campaign_name}
                    </span>
                  </div>
                </TableCell>

                <TableCell className="text-muted-foreground w-[150px]">
                  {since ? (
                    <div className="flex flex-col gap-0.5">
                      <span className="text-foreground text-sm">
                        {since.label}
                      </span>
                      <span className="text-[11px]">
                        {lead.goalMetAt
                          ? new Date(lead.goalMetAt).toLocaleString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                            })
                          : ""}
                      </span>
                    </div>
                  ) : (
                    <span className="text-xs">—</span>
                  )}
                </TableCell>

                <TableCell className="w-[110px]">
                  <ViewOriginalCallLink callId={lead.originating_call_id} />
                </TableCell>

                <TableCell className="bg-background sticky right-0 z-10 w-[270px] text-right shadow-[-8px_0_16px_-8px_rgba(0,0,0,0.06)] transition-colors group-hover:bg-[color-mix(in_oklab,var(--muted)_50%,var(--background))]">
                  <GoalStatusActions
                    leadId={lead.id}
                    currentStatus={lead.status}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
