"use client";

import { ExternalLink, MoreVertical, PhoneCall, Play } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Hover-only action cluster at the right edge of every call row.
 *  Listen + Open lead + a kebab for less-common actions. Each handler
 *  stops click propagation so the row-level "open the detail modal"
 *  navigation doesn't also fire.
 *
 *  Listen opens the detail modal (same as clicking the row) — the
 *  modal already hosts the audio player. Open-lead deep-links to the
 *  full /leads/<id> route. */
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="More call actions"
            onClick={stop}
          >
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={stop}>
          {leadId ? (
            <>
              <DropdownMenuItem onClick={openLead}>
                <ExternalLink className="size-4" />
                Open lead
              </DropdownMenuItem>
              <DropdownMenuItem onClick={callBack}>
                <PhoneCall className="size-4" />
                Call this lead again
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem onClick={listen}>
            <Play className="size-4" />
            Open detail
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
