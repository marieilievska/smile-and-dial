"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { rescheduleRegistration } from "@/lib/goals/reschedule-actions";
import type { SessionOption } from "@/lib/goals/webinar-sessions";

/** Asks which session a person moved to, then records it.
 *
 *  Marking someone "Rescheduled" without a date would lose them: they would sit
 *  outside both the attended and no-show counts with nothing to watch for. So
 *  the move is only recorded once a new session is chosen — and their dial day
 *  is left untouched, so the credit stays with the day that paid for them. */
export function RescheduleDialog({
  open,
  onOpenChange,
  leadId,
  leadName,
  sessions,
  onDone,
  onCancel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string | null;
  leadName: string;
  sessions: SessionOption[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<string>("");
  const [pending, startTransition] = useTransition();

  function close(committed: boolean) {
    setSelected("");
    onOpenChange(false);
    if (!committed) onCancel();
  }

  function submit() {
    if (!leadId || !selected) return;
    startTransition(async () => {
      const result = await rescheduleRegistration({
        leadId,
        newSessionIso: selected,
      });
      if (result.error) {
        toast.error(result.error);
        close(false);
        return;
      }
      toast.success("Moved to the new session.");
      close(true);
      onDone();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close(false);
        else onOpenChange(true);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Which session did they move to?</DialogTitle>
          <DialogDescription>
            {leadName} keeps the day they were called on, so the cost still
            counts against that day — only the session changes.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5 py-2">
          {sessions.map((s) => (
            <label
              key={s.iso}
              className={
                "flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors " +
                (selected === s.iso
                  ? "border-primary bg-primary/5"
                  : "border-border hover:bg-muted/60")
              }
            >
              <input
                type="radio"
                name="session"
                value={s.iso}
                checked={selected === s.iso}
                onChange={() => setSelected(s.iso)}
                className="accent-primary"
              />
              {s.label}
            </label>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!selected || pending}>
            {pending ? "Moving…" : "Move to this session"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
