"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ListChecks, Pencil, Power } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { setFlagActive, updateFlagDef } from "@/lib/review/actions";
import type { CandidateFlag, ChecklistFlag } from "@/lib/review/buckets";

import { SuggestedFlagsPanel } from "./suggested-flags-panel";

/** "The AI's checklist": what the reviewer looks for on every call. Turn a noisy
 *  flag off, edit what it means, or add one of the AI's suggestions. */
export function AiChecklistPanel({
  flags,
  candidates,
}: {
  flags: ChecklistFlag[];
  candidates: CandidateFlag[];
}) {
  const active = flags.filter((f) => f.active);
  const retired = flags.filter((f) => !f.active);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <ListChecks className="text-muted-foreground size-5" />
        <h2 className="text-foreground text-base font-semibold">
          The AI&apos;s checklist
        </h2>
      </div>
      <p className="text-muted-foreground -mt-2 text-xs">
        What the reviewer looks for on every call. Turn off ones that misfire,
        edit what a flag means to sharpen it, or add a suggestion below.
      </p>
      <SuggestedFlagsPanel candidates={candidates} />
      {active.length > 0 ? (
        <div className="border-border overflow-hidden rounded-xl border">
          {active.map((f, i) => (
            <ChecklistRow key={f.key} flag={f} topBorder={i > 0} />
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          No active flags — the reviewer isn&apos;t checking anything right now.
        </p>
      )}
      {retired.length > 0 ? (
        <details className="text-muted-foreground text-xs">
          <summary className="cursor-pointer select-none">
            Turned off ({retired.length})
          </summary>
          <div className="border-border mt-2 overflow-hidden rounded-xl border">
            {retired.map((f, i) => (
              <ChecklistRow key={f.key} flag={f} topBorder={i > 0} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function ChecklistRow({
  flag,
  topBorder,
}: {
  flag: ChecklistFlag;
  topBorder: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const total = flag.confirmed + flag.rejected;
  const falseAlarmPct =
    total > 0 ? Math.round((flag.rejected / total) * 100) : 0;

  function toggle() {
    start(async () => {
      const r = await setFlagActive({ key: flag.key, active: !flag.active });
      if (r.error) {
        toast.error(r.error);
        return;
      }
      toast.success(flag.active ? "Turned off." : "Turned on.");
      router.refresh();
    });
  }

  return (
    <div
      className={`flex items-start justify-between gap-3 px-4 py-3 ${
        topBorder ? "border-border border-t" : ""
      } ${flag.active ? "" : "opacity-60"}`}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-foreground text-sm font-medium">
            {flag.label}
          </span>
          <Badge variant="outline">sev {flag.severity}</Badge>
          {total > 0 ? (
            <span
              className={`text-xs ${
                falseAlarmPct >= 40 ? "text-amber-700" : "text-muted-foreground"
              }`}
            >
              {flag.confirmed} right · {flag.rejected} false alarm
              {falseAlarmPct >= 40 ? ` (${falseAlarmPct}% off)` : ""}
            </span>
          ) : (
            <span className="text-muted-foreground text-xs">
              no history yet
            </span>
          )}
        </div>
        <p className="text-muted-foreground text-xs">{flag.guidance}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <EditFlagDialog flag={flag} onDone={() => router.refresh()} />
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={toggle}
          title={flag.active ? "Turn this flag off" : "Turn this flag back on"}
        >
          <Power className="size-4" />
          {flag.active ? "Turn off" : "Turn on"}
        </Button>
      </div>
    </div>
  );
}

function EditFlagDialog({
  flag,
  onDone,
}: {
  flag: ChecklistFlag;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [label, setLabel] = useState(flag.label);
  const [guidance, setGuidance] = useState(flag.guidance);

  function save() {
    start(async () => {
      const r = await updateFlagDef({ key: flag.key, label, guidance });
      if (r.error) {
        toast.error(r.error);
        return;
      }
      toast.success("Saved.");
      setOpen(false);
      onDone();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" title="Edit what this flag means">
          <Pencil className="size-4" />
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit flag</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="flag-label">Name</Label>
            <Input
              id="flag-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="flag-guidance">
              What it checks (the AI reads this)
            </Label>
            <Textarea
              id="flag-guidance"
              rows={4}
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
