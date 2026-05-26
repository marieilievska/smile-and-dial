"use client";

import { useState, useTransition } from "react";
import { CalendarClock, XCircle } from "lucide-react";
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
import { cancelCallback, rescheduleCallback } from "@/lib/callbacks/actions";

/** Per-row Reschedule + Cancel controls on the Callbacks page. Only the
 *  pending callbacks render these; completed/missed/cancelled ones are
 *  rendered without actions. */
export function CallbackRowActions({
  callbackId,
  currentScheduledAt,
}: {
  callbackId: string;
  currentScheduledAt: string;
}) {
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  // datetime-local needs yyyy-MM-ddTHH:mm in LOCAL time, not ISO/UTC.
  const initial = (() => {
    const d = new Date(currentScheduledAt);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  })();
  const [when, setWhen] = useState(initial);
  const [pending, startTransition] = useTransition();

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

  return (
    <div className="flex justify-end gap-1">
      <Dialog open={rescheduleOpen} onOpenChange={setRescheduleOpen}>
        <DialogTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="Reschedule callback">
            <CalendarClock className="size-4" />
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reschedule callback</DialogTitle>
            <DialogDescription>
              The dialer will redial at the new time, respecting calling hours +
              pre-call checks.
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
            variant="ghost"
            size="sm"
            aria-label="Cancel callback"
            disabled={pending}
          >
            <XCircle className="size-4" />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel callback?</AlertDialogTitle>
            <AlertDialogDescription>
              The lead will move back to ready to call. The original call row
              stays in the audit trail.
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
    </div>
  );
}
