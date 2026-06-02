"use client";

import { CalendarClock, Phone, Trash2, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  cancelCallback,
  deleteCallbacks,
  rescheduleCallback,
} from "@/lib/callbacks/actions";

/** Hover-only action cluster at the right edge of every pending
 *  callback row. Three affordances:
 *   - **Call now** (coral, primary) — jumps to /leads/<id>?action=call
 *     so the operator can place the dial right now instead of waiting
 *     for the cron to pick up the scheduled time.
 *   - **Reschedule** (ghost, labelled) — opens a datetime dialog.
 *   - **Cancel** (ghost destructive, labelled) — soft-cancels via the
 *     server action; the row stays for audit, status flips to
 *     `cancelled`.
 *
 *  v2 (round 9): replaced bare icon-only buttons with icon + label
 *  hover-only buttons matching the calls list pattern. All event
 *  handlers stopPropagation so the row's "open lead" handler
 *  doesn't also fire when the user is acting *on* the row. */
export function CallbackRowActions({
  callbackId,
  leadId,
  currentScheduledAt,
  isPending,
  isAdmin = false,
}: {
  callbackId: string;
  leadId: string | null;
  currentScheduledAt: string;
  isPending: boolean;
  isAdmin?: boolean;
}) {
  const router = useRouter();
  const [rescheduleOpen, setRescheduleOpen] = useState(false);

  // datetime-local needs yyyy-MM-ddTHH:mm in LOCAL time, not ISO/UTC.
  const initial = (() => {
    const d = new Date(currentScheduledAt);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  })();
  const [when, setWhen] = useState(initial);
  const [pending, startTransition] = useTransition();

  function stop(event: React.SyntheticEvent) {
    event.stopPropagation();
  }

  function callNow(event: React.MouseEvent) {
    event.stopPropagation();
    if (!leadId) return;
    router.push(`/leads/${leadId}?action=call`);
  }

  function reschedule() {
    if (!when) return;
    startTransition(async () => {
      const result = await rescheduleCallback({
        callbackId,
        scheduledAt: new Date(when).toISOString(),
      });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success("Rescheduled.");
      setRescheduleOpen(false);
    });
  }

  function confirmCancel() {
    startTransition(async () => {
      const result = await cancelCallback(callbackId);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success("Callback cancelled.");
    });
  }

  function confirmDelete() {
    startTransition(async () => {
      const result = await deleteCallbacks([callbackId]);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success("Callback deleted.");
      router.refresh();
    });
  }

  return (
    <div
      data-testid="callback-row-actions"
      onClick={stop}
      onKeyDown={stop}
      className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
    >
      {isPending ? (
        <>
          {/* Call now — primary action when an SDR sees a callback they
          want to handle immediately instead of waiting for the cron. */}
          {leadId ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={callNow}
              className="text-primary hover:bg-primary/10 hover:text-primary h-7 px-2"
              title="Call this lead now"
            >
              <Phone className="size-3.5" />
              Call now
            </Button>
          ) : null}

          <Dialog open={rescheduleOpen} onOpenChange={setRescheduleOpen}>
            <DialogTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                title="Reschedule callback"
                onClick={stop}
              >
                <CalendarClock className="size-3.5" />
                Reschedule
              </Button>
            </DialogTrigger>
            <DialogContent onClick={stop}>
              <DialogHeader>
                <DialogTitle>Reschedule callback</DialogTitle>
                <DialogDescription>
                  The dialer will redial at the new time, respecting calling
                  hours + pre-call checks.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`when-${callbackId}`}>When</Label>
                <Input
                  id={`when-${callbackId}`}
                  type="datetime-local"
                  value={when}
                  onChange={(event) => setWhen(event.target.value)}
                  required
                />
              </div>
              <DialogFooter>
                <Button onClick={reschedule} disabled={!when || pending}>
                  {pending ? "Saving…" : "Reschedule"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending}
                className="text-destructive hover:text-destructive hover:bg-destructive/10 h-7 px-2"
                title="Cancel callback"
                onClick={stop}
              >
                <XCircle className="size-3.5" />
                Cancel
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent onClick={stop}>
              <AlertDialogHeader>
                <AlertDialogTitle>Cancel callback?</AlertDialogTitle>
                <AlertDialogDescription>
                  The lead will move back to ready to call. The original call
                  row stays in the audit trail.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep</AlertDialogCancel>
                <AlertDialogAction onClick={confirmCancel} disabled={pending}>
                  Cancel callback
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : null}

      {/* Delete — admin-only hard delete, available on every row (any
          status) for clearing test/junk callbacks. */}
      {isAdmin ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              className="text-destructive hover:text-destructive hover:bg-destructive/10 h-7 px-2"
              title="Delete callback"
              onClick={stop}
              data-testid="callback-row-delete"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent onClick={stop}>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this callback?</AlertDialogTitle>
              <AlertDialogDescription>
                This permanently removes the callback. If it&apos;s still
                pending, the lead is handed back to the standard queue. This
                cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep</AlertDialogCancel>
              <AlertDialogAction onClick={confirmDelete} disabled={pending}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}
