"use client";

import { Check } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { setLeadStatus } from "@/lib/leads/inline-actions";
import { LEAD_STATUS_LABELS } from "@/lib/labels";

import { statusVariant } from "./columns";

/** Stable, ordered status options for the inline picker. Mirrors the
 *  Leads page filter's "open" set ordering: ready → callback → goal_met
 *  → attended → sale (the happy path), then resting → email_replied →
 *  no_show (in-progress detours), then dnc → closed (terminal). */
const STATUS_OPTIONS = [
  "ready_to_call",
  "callback",
  "goal_met",
  "attended",
  "sale",
  "resting",
  "email_replied",
  "no_show",
  "dnc",
  "closed",
] as const;

/** Inline Stage cell. Click the pill, pick a new status, it saves.
 *  No detail-page round-trip. Round 36+ (I3) — wraps the existing
 *  Badge with a Popover so the visual treatment of the pill is
 *  identical to the read-only render; only the affordance changes.
 *
 *  Optimistic state — `localStatus` flips the moment the user picks,
 *  so the badge re-colours before the server confirms. If the server
 *  rejects (RLS, invalid value, etc.) the toast surfaces it and we
 *  revert.
 *
 *  The Popover stops click propagation so the surrounding LeadRow's
 *  navigation doesn't fire when the operator is just changing a
 *  stage. */
export function InlineStatusCell({
  leadId,
  status,
}: {
  leadId: string;
  status: string;
}) {
  const [open, setOpen] = useState(false);
  const [localStatus, setLocalStatus] = useState(status);
  const [pending, startTransition] = useTransition();

  // Reconcile when the row's underlying value changes (e.g. parent
  // page revalidated after a bulk action). React's controlled-from-
  // server pattern: derive from props on render rather than holding
  // stale state.
  if (status !== localStatus && !pending) {
    // Local has drifted from props but we're not mid-flight; the
    // server is the source of truth, so adopt the new prop value.
    setLocalStatus(status);
  }

  function pick(next: string) {
    if (next === localStatus) {
      setOpen(false);
      return;
    }
    const previous = localStatus;
    setLocalStatus(next);
    setOpen(false);
    startTransition(async () => {
      const result = await setLeadStatus({ leadId, status: next });
      if (result.error) {
        toast.error(result.error);
        setLocalStatus(previous);
      } else {
        toast.success("Stage updated.");
      }
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="lead-status-trigger"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          disabled={pending}
          className="focus-visible:ring-ring/60 inline-flex cursor-pointer items-center rounded-full transition-opacity focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
          // The aria-label avoids the word "Stage" to keep the
          // Playwright `getByLabel("Stage")` contract on the filter
          // dialog working — Playwright matches by substring, so any
          // row trigger containing "Stage" would compete for the
          // accessible-name selector. "Pipeline" carries the same
          // meaning for screen readers.
          aria-label={`Pipeline ${LEAD_STATUS_LABELS[localStatus] ?? localStatus}, click to change`}
        >
          <Badge variant={statusVariant(localStatus)} dot>
            {LEAD_STATUS_LABELS[localStatus] ?? localStatus}
          </Badge>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-56 p-1"
        onClick={(event) => event.stopPropagation()}
      >
        <div
          role="listbox"
          aria-label="Pick a stage"
          className="flex flex-col gap-0.5"
        >
          {STATUS_OPTIONS.map((option) => {
            const isCurrent = option === localStatus;
            return (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={isCurrent}
                onClick={() => pick(option)}
                className="hover:bg-muted/60 focus-visible:bg-muted/60 flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors focus-visible:outline-none"
              >
                <span className="flex items-center gap-2">
                  <Badge variant={statusVariant(option)} dot>
                    {LEAD_STATUS_LABELS[option] ?? option}
                  </Badge>
                </span>
                {isCurrent ? (
                  <Check className="text-muted-foreground size-3.5" />
                ) : null}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
