"use client";

import { AlertTriangle, CheckCircle2, Plus } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { addToDnc, type DncReason } from "@/lib/dnc/actions";

/** Reasons + a short helper line each. The helper sits under the
 *  selected reason in the dialog so the operator can confirm the
 *  intent without leaving the modal. */
const REASONS: { value: DncReason; label: string; helper: string }[] = [
  {
    value: "manual",
    label: "Manual",
    helper: "Operator-initiated addition with no specific upstream signal.",
  },
  {
    value: "dnc_requested",
    label: "Caller requested",
    helper:
      "The person on the line explicitly asked to be removed from outreach.",
  },
  {
    value: "invalid_number",
    label: "Invalid number",
    helper:
      "Carrier rejected the number, or it routes somewhere we shouldn't dial.",
  },
  {
    value: "language_barrier",
    label: "Language barrier",
    helper: "We couldn't communicate; better to stop calling than keep trying.",
  },
  {
    value: "imported",
    label: "Imported",
    helper:
      "Sourced from an external DNC list. Use the CSV importer for bulk uploads.",
  },
];

/** Inline E.164 validator — same shape as the CSV importer's check
 *  but it runs while the user types so they see green/red immediately
 *  instead of waiting for the server round-trip. */
const E164 = /^\+[1-9]\d{1,14}$/;

/** Normalise the phone for validation only. Operators paste in
 *  everything from "(212) 555-0101" to "+1 212-555-0101"; we strip
 *  the cosmetics and infer a +1 for plain 10-digit US numbers. */
function normalizePhone(raw: string): string {
  let s = raw.trim().replace(/^tel:/i, "");
  if (!s) return "";
  const hasPlus = s.startsWith("+");
  s = s.replace(/[^\d]/g, "");
  if (!s) return "";
  if (hasPlus) return `+${s}`;
  if (s.length === 10) return `+1${s}`;
  if (s.length === 11 && s.startsWith("1")) return `+${s}`;
  return "";
}

type Validity = "idle" | "valid" | "invalid";

/** Add a single number to the workspace DNC list. Slim labeled
 *  fields with live phone validation, per-reason helper text, and an
 *  "Add another" affordance so an operator cleaning up post-call work
 *  can stay in the modal. */
export function AddDncDialog() {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState<DncReason>("manual");
  const [company, setCompany] = useState("");
  const [addAnother, setAddAnother] = useState(false);
  const [pending, startTransition] = useTransition();

  const normalised = normalizePhone(phone);
  const validity: Validity = !phone.trim()
    ? "idle"
    : E164.test(normalised)
      ? "valid"
      : "invalid";
  const reasonMeta = useMemo(
    () => REASONS.find((r) => r.value === reason) ?? REASONS[0],
    [reason],
  );

  function reset() {
    setPhone("");
    setReason("manual");
    setCompany("");
  }

  function submit() {
    if (validity !== "valid") return;
    startTransition(async () => {
      const result = await addToDnc({ phone: normalised, reason, company });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success("Added to DNC.");
      reset();
      if (!addAnother) setOpen(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus className="size-4" />
          Add number
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add number to DNC</DialogTitle>
          <DialogDescription>
            The dialer will skip this number across every campaign.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Phone — live green/red validation as the operator types */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dnc-phone">Phone</Label>
            <div className="relative">
              <Input
                id="dnc-phone"
                type="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="+1 212 555 0101"
                aria-invalid={validity === "invalid"}
                className={
                  validity === "invalid"
                    ? "aria-invalid:ring-destructive/30 aria-invalid:border-destructive pr-9"
                    : "pr-9"
                }
                required
              />
              {validity === "valid" ? (
                <CheckCircle2 className="text-success absolute top-1/2 right-2.5 size-4 -translate-y-1/2" />
              ) : validity === "invalid" ? (
                <AlertTriangle className="text-destructive absolute top-1/2 right-2.5 size-4 -translate-y-1/2" />
              ) : null}
            </div>
            {validity === "valid" ? (
              <p className="text-success text-xs">
                Will be saved as{" "}
                <span className="font-mono font-medium">{normalised}</span>.
              </p>
            ) : validity === "invalid" ? (
              <p className="text-destructive text-xs">
                That doesn&apos;t look like a valid phone. Use E.164 (e.g.
                +12125550101) or a 10-digit US number.
              </p>
            ) : (
              <p className="text-muted-foreground text-xs">
                E.164 format. We&apos;ll infer the +1 from a plain 10-digit US
                number.
              </p>
            )}
          </div>

          {/* Reason — helper line reflects the current selection */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dnc-reason">Reason</Label>
            <Select
              value={reason}
              onValueChange={(value) => setReason(value as DncReason)}
            >
              <SelectTrigger id="dnc-reason">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REASONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">{reasonMeta.helper}</p>
          </div>

          {/* Company — optional context */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dnc-company">Company</Label>
            <Input
              id="dnc-company"
              value={company}
              onChange={(event) => setCompany(event.target.value)}
              placeholder="ABC Fitness"
            />
            <p className="text-muted-foreground text-xs">
              Optional. Saved as a snapshot so the row stays readable later.
            </p>
          </div>
        </div>

        <DialogFooter className="flex-row items-center justify-between gap-3 sm:justify-between">
          <label className="text-muted-foreground inline-flex cursor-pointer items-center gap-2 text-sm select-none">
            <Checkbox
              checked={addAnother}
              onCheckedChange={(v) => setAddAnother(v === true)}
              aria-label="Keep this dialog open after adding"
            />
            Add another
          </label>
          <Button onClick={submit} disabled={pending || validity !== "valid"}>
            {pending ? "Adding…" : "Add to DNC"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
