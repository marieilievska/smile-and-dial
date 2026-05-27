"use client";

import { ExternalLink, PhoneCall, Play } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";

/** Hover-only action cluster at the right edge of every call row.
 *
 *  v2 (round 5) — dropped the kebab dropdown entirely. The row itself
 *  is the click target for opening the detail modal, so a separate
 *  "Open detail" menu item was redundant. The two leftover lead-level
 *  actions (open the lead, call them again) are now visible buttons
 *  that match the Listen affordance — same hover-only behavior, same
 *  ghost button styling.
 *
 *  Each handler stops click propagation so the row-level "open the
 *  detail modal" navigation doesn't also fire when the user is
 *  acting *on* the row instead of opening it. */
export function CallRowActions({
  callId,
  leadId,
  hasRecording,
}: {
  callId: string;
  leadId: string | null;
  hasRecording: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function stop(event: React.SyntheticEvent) {
    event.stopPropagation();
  }

  function listen(event: React.MouseEvent) {
    event.stopPropagation();
    const params = new URLSearchParams(searchParams.toString());
    params.set("call", callId);
    router.push(`/calls?${params.toString()}`, { scroll: false });
  }

  function openLead(event: React.MouseEvent) {
    event.stopPropagation();
    if (!leadId) return;
    router.push(`/leads/${leadId}`);
  }

  function callBack(event: React.MouseEvent) {
    event.stopPropagation();
    if (!leadId) return;
    router.push(`/leads/${leadId}?action=call`);
  }

  return (
    <div
      data-testid="call-row-actions"
      onClick={stop}
      onKeyDown={stop}
      className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
    >
      {hasRecording ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={listen}
          className="h-7 px-2 text-[color:var(--coral)] hover:bg-[color:var(--coral)]/10 hover:text-[color:var(--coral)]"
          title="Listen to the recording"
        >
          <Play className="size-3.5" />
          Listen
        </Button>
      ) : null}
      {leadId ? (
        <>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={openLead}
            className="h-7 px-2"
            title="Open the lead's detail page"
          >
            <ExternalLink className="size-3.5" />
            Open lead
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={callBack}
            className="h-7 px-2 text-[color:var(--coral)] hover:bg-[color:var(--coral)]/10 hover:text-[color:var(--coral)]"
            title="Call this lead again"
          >
            <PhoneCall className="size-3.5" />
            Call lead
          </Button>
        </>
      ) : null}
    </div>
  );
}
