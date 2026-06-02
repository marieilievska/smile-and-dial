"use client";

import { PhoneCall, Play, Trash2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { deleteCalls } from "@/lib/calls/actions";

/** Hover-only action cluster at the right edge of every call row.
 *
 *  v3 (round 7) — dropped the "Open lead" button. The lead's company
 *  name in the primary cell is now a real <Link>, so clicking the
 *  company name navigates to the lead and middle-click / cmd-click
 *  opens it in a new tab. That left Listen + Call lead as the only
 *  hover affordances, which keeps the sticky action cell narrow and
 *  uncluttered.
 *
 *  Each handler stops click propagation so the row-level "open the
 *  detail modal" navigation doesn't also fire when the user is
 *  acting *on* the row instead of opening it. */
export function CallRowActions({
  callId,
  leadId,
  hasRecording,
  isAdmin = false,
}: {
  callId: string;
  leadId: string | null;
  hasRecording: boolean;
  isAdmin?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function stop(event: React.SyntheticEvent) {
    event.stopPropagation();
  }

  function onDelete() {
    startTransition(async () => {
      const r = await deleteCalls([callId]);
      if (r.error) toast.error(r.error);
      else {
        toast.success("Call deleted.");
        router.refresh();
      }
    });
  }

  function listen(event: React.MouseEvent) {
    event.stopPropagation();
    const params = new URLSearchParams(searchParams.toString());
    params.set("call", callId);
    router.push(`/calls?${params.toString()}`, { scroll: false });
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
          className="text-primary hover:bg-primary/10 hover:text-primary h-7 px-2"
          title="Listen to the recording"
        >
          <Play className="size-3.5" />
          Listen
        </Button>
      ) : null}
      {leadId ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={callBack}
          className="text-primary hover:bg-primary/10 hover:text-primary h-7 px-2"
          title="Call this lead again"
        >
          <PhoneCall className="size-3.5" />
          Call lead
        </Button>
      ) : null}
      {isAdmin ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive h-7 px-2"
              title="Delete this call"
              data-testid="call-row-delete"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this call?</AlertDialogTitle>
              <AlertDialogDescription>
                This permanently removes the call and its recording, and drops
                it from cost and analytics totals. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={onDelete} disabled={pending}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}
