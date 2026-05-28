"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { formatPhone } from "@/lib/format-phone";
import { GOAL_STATUSES, type GoalStatus } from "@/lib/goals/goal-statuses";
import { transitionLeadGoalStatus } from "@/lib/goals/pipeline-actions";

import { formatSince } from "./format-since";
import type { PipelineLead } from "./pipeline-types";
import { GOAL_STATUS_LABELS, goalStatusVariant } from "./status-variant";

/** Kanban board view of the goal pipeline. Five columns matching the
 *  goal statuses; cards are leads. Drag a card to a different column
 *  to transition the lead's status — uses native HTML5 drag-and-drop
 *  (no library), optimistic UI (the card moves immediately; if the
 *  server rejects we toast + refresh to snap it back).
 *
 *  Clicking a card navigates to the lead detail page. The card stops
 *  propagation on internal links / buttons.
 *
 *  Column header counts update optimistically — they're derived from
 *  the local `leads` state which we mutate in place when a drop
 *  succeeds. */
export function PipelineBoard({
  leads: initialLeads,
}: {
  leads: PipelineLead[];
}) {
  const router = useRouter();
  const [leads, setLeads] = useState(initialLeads);
  const [, startTransition] = useTransition();
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<GoalStatus | null>(null);

  // Re-sync local state when the server-rendered list changes (after a
  // router.refresh / filter change).
  if (leads !== initialLeads && draggingId == null) {
    setLeads(initialLeads);
  }

  function onDrop(event: React.DragEvent, target: GoalStatus) {
    event.preventDefault();
    const id = event.dataTransfer.getData("text/plain");
    setOverColumn(null);
    setDraggingId(null);
    if (!id) return;
    const lead = leads.find((l) => l.id === id);
    if (!lead || lead.status === target) return;

    // Optimistic: move the card immediately, then await the server.
    const prevStatus = lead.status;
    setLeads((prev) =>
      prev.map((l) => (l.id === id ? { ...l, status: target } : l)),
    );

    startTransition(async () => {
      const result = await transitionLeadGoalStatus({
        leadId: id,
        status: target,
      });
      if (result.error) {
        // Snap back on failure.
        setLeads((prev) =>
          prev.map((l) => (l.id === id ? { ...l, status: prevStatus } : l)),
        );
        toast.error(result.error);
        return;
      }
      toast.success(`Marked ${GOAL_STATUS_LABELS[target]}.`);
      router.refresh();
    });
  }

  return (
    <div
      data-testid="pipeline-board"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5"
    >
      {GOAL_STATUSES.map((status) => {
        const columnLeads = leads.filter((l) => l.status === status);
        const isOver = overColumn === status;
        return (
          <div
            key={status}
            onDragOver={(event) => {
              // Required for `drop` to fire on this element.
              event.preventDefault();
              if (overColumn !== status) setOverColumn(status);
            }}
            onDragLeave={(event) => {
              // Only clear when we actually leave the column box (not
              // when moving between children).
              const rt = event.relatedTarget as Node | null;
              if (!rt || !event.currentTarget.contains(rt)) {
                setOverColumn((cur) => (cur === status ? null : cur));
              }
            }}
            onDrop={(event) => onDrop(event, status)}
            className={`flex min-h-[160px] flex-col gap-2 rounded-xl border p-3 transition-colors ${
              isOver
                ? "bg-primary/5 border-[color:var(--primary)]"
                : "border-border bg-card"
            }`}
          >
            <div className="flex items-center justify-between">
              <Badge variant={goalStatusVariant(status)} dot>
                {GOAL_STATUS_LABELS[status]}
              </Badge>
              <span className="text-muted-foreground text-xs tabular-nums">
                {columnLeads.length}
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {columnLeads.length === 0 ? (
                <p className="text-muted-foreground border-border/60 rounded-md border border-dashed py-6 text-center text-xs">
                  Drop here
                </p>
              ) : (
                columnLeads.map((lead) => (
                  <BoardCard
                    key={lead.id}
                    lead={lead}
                    isDragging={draggingId === lead.id}
                    onDragStart={() => setDraggingId(lead.id)}
                    onDragEnd={() => setDraggingId(null)}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BoardCard({
  lead,
  isDragging,
  onDragStart,
  onDragEnd,
}: {
  lead: PipelineLead;
  isDragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const since = formatSince(lead.goalMetAt);
  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("text/plain", lead.id);
        event.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={`bg-background border-border group flex flex-col gap-1.5 rounded-lg border p-3 transition-shadow ${
        isDragging ? "opacity-50" : "hover:shadow-sm"
      }`}
      title="Drag to move; click to open lead"
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <Link
          href={`/leads/${lead.id}`}
          onClick={(e) => e.stopPropagation()}
          className="text-foreground hover:text-primary truncate text-sm font-medium underline-offset-2 hover:underline"
        >
          {lead.company || "Unknown lead"}
        </Link>
        {since?.stale ? (
          <span
            className="bg-primary/10 text-primary inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium"
            title="Sitting in the pipeline for 2+ weeks"
          >
            Stale
          </span>
        ) : null}
      </div>
      {lead.business_phone ? (
        <span className="text-muted-foreground truncate font-mono text-[11px]">
          {formatPhone(lead.business_phone)}
        </span>
      ) : null}
      <div className="text-muted-foreground flex items-center justify-between text-[11px]">
        <span className="truncate">{lead.campaign_name}</span>
        {since ? <span className="shrink-0">{since.label}</span> : null}
      </div>
    </div>
  );
}
